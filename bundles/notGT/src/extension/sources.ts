import fs from "node:fs";
import path from "node:path";

import {
	BUNDLE_NAME,
	REPLICANTS,
	newId,
	type DataSource,
	type DataSourceMode,
	type DataSourceProblem,
	type DataSourceSheet,
	type TitleData,
} from "../shared/types";
import type { ApiRequest, ApiResponse, Handler } from "./auth";
import { fieldName, readWorkbook, writeWorkbook, type SheetTable } from "./excel";
import type { ServerAPI, Store } from "./store";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	delete(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** An edit is written once typing has paused for this long. */
const WRITE_DELAY_MS = 600;
/** How often a tracked file is looked at. Polling survives the "write a copy,
    rename it over the original" save that spreadsheets do; a watch does not. */
const TRACK_INTERVAL_MS = 1000;

/** Sheet names a spreadsheet gives by itself; they say nothing, so the file name is used. */
const DEFAULT_SHEET = /^(sheet|лист|table|таблица)\s*\d*$/i;

function isWorkbookName(name: string): boolean {
	return /\.xlsx$/i.test(name);
}

/** Keeps a file name safe for the filesystem without mangling non-Latin names. */
function safeBase(name: string): string {
	const cleaned = path
		.basename(name, path.extname(name))
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 60);
	return cleaned || "workbook";
}

/**
 * The variable a sheet becomes. A named sheet gives its name; a "Sheet1" gives
 * the file's. Dots and brackets would split the binding path, spaces would be
 * awkward in one.
 */
function variableName(sheet: string, fileBase: string, onlySheet: boolean): string {
	const raw = DEFAULT_SHEET.test(sheet.trim())
		? onlySheet
			? fileBase
			: `${fileBase} ${sheet}`
		: sheet;
	return fieldName(raw).replace(/\s+/g, "_") || "table";
}

function problemOf(error: unknown): DataSourceProblem {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return "missing";
	if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "EROFS") return "locked";
	return "failed";
}

function pickString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return undefined;
}

/** The outcome of connecting a workbook: a source, or the variables it would replace. */
type Connected = { source: DataSource } | { conflicts: string[] };

class SourceError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Spreadsheets as list variables.
 *
 * A connected workbook and the variable store mirror each other: reading the
 * file sets the variables, and a change of a variable — from the dashboard or
 * the API alike — is written into the file. For a tracked file the file is the
 * master: when it changes on disk it is read again and replaces the list.
 */
export function createSources(
	nodecg: ServerAPI,
	store: Store,
	dir: string,
	authCheck: Handler,
): { router: unknown; start(): void } {
	const log = nodecg.log;
	const sources = nodecg.Replicant<DataSource[]>(REPLICANTS.sources, BUNDLE_NAME, {
		defaultValue: [],
		persistent: true,
	});

	/** What each mirrored variable looked like when it last agreed with its file. */
	const snapshots = new Map<string, string>();
	/** One chain of reads and writes per source, so they never overlap. */
	const chains = new Map<string, Promise<void>>();
	const writeTimers = new Map<string, NodeJS.Timeout>();
	/** The modification time each file had right after notGT wrote it. */
	const ownWrites = new Map<string, number>();
	const watched = new Map<string, string>();

	fs.mkdirSync(dir, { recursive: true });

	const list = (): DataSource[] => sources.value ?? [];
	const find = (id: string): DataSource | undefined => list().find((source) => source.id === id);

	function update(id: string, patch: Partial<DataSource>): void {
		sources.value = list().map((source) => (source.id === id ? { ...source, ...patch } : source));
	}

	function settled(id: string): void {
		update(id, { state: "ok", problem: undefined, detail: undefined, syncedAt: Date.now() });
	}

	function failed(id: string, error: unknown, fallback?: DataSourceProblem): void {
		const found = problemOf(error);
		const problem = found === "failed" && fallback ? fallback : found;
		update(id, { state: "error", problem, detail: String((error as Error)?.message ?? error) });
		log.warn("Data source %s: %s", find(id)?.name ?? id, String(error));
	}

	function enqueue(id: string, job: () => Promise<void>): Promise<void> {
		const next = (chains.get(id) ?? Promise.resolve()).then(job, job);
		chains.set(id, next);
		return next;
	}

	const snapshotOf = (value: unknown): string => JSON.stringify(value ?? null);

	// ------------------------------------------------------- file → variables
	async function read(source: DataSource): Promise<void> {
		let tables: SheetTable[];
		try {
			// The reader's own "not found" carries no error code.
			await fs.promises.access(source.path);
			tables = await readWorkbook(source.path);
		} catch (error) {
			failed(source.id, error, "unreadable");
			return;
		}
		const patch: TitleData = {};
		for (const mapped of source.sheets) {
			const table = tables.find((entry) => entry.sheet === mapped.sheet);
			// A sheet that was deleted from the file leaves its list as it is.
			if (!table) continue;
			patch[mapped.variable] = table.rows;
			// Before the store is written: its change event fires at once.
			snapshots.set(mapped.variable, snapshotOf(table.rows));
		}
		store.setData(patch, "merge");
		settled(source.id);
	}

	// ------------------------------------------------------- variables → file
	async function write(source: DataSource): Promise<void> {
		const data = store.readData();
		const tables = source.sheets
			.filter((mapped) => Array.isArray(data[mapped.variable]))
			.map((mapped) => ({
				sheet: mapped.sheet,
				variable: mapped.variable,
				rows: data[mapped.variable] as Array<Record<string, unknown>>,
			}));
		try {
			const changed = await writeWorkbook(source.path, tables);
			if (changed) ownWrites.set(source.id, fs.statSync(source.path).mtimeMs);
			for (const table of tables) snapshots.set(table.variable, snapshotOf(table.rows));
			settled(source.id);
		} catch (error) {
			failed(source.id, error);
		}
	}

	function scheduleWrite(id: string): void {
		clearTimeout(writeTimers.get(id));
		writeTimers.set(
			id,
			setTimeout(() => {
				writeTimers.delete(id);
				void enqueue(id, async () => {
					const source = find(id);
					if (source) await write(source);
				});
			}, WRITE_DELAY_MS),
		);
	}

	store.titleData.on("change", () => {
		const data = store.readData();
		for (const source of list()) {
			// A list that was deleted, or turned into something else, lets go of its sheet.
			const kept = source.sheets.filter((mapped) => Array.isArray(data[mapped.variable]));
			if (kept.length !== source.sheets.length) {
				for (const mapped of source.sheets) {
					if (!kept.includes(mapped)) snapshots.delete(mapped.variable);
				}
				if (kept.length === 0) {
					disconnect(source.id);
					continue;
				}
				update(source.id, { sheets: kept });
			}
			if (kept.some((mapped) => snapshots.get(mapped.variable) !== snapshotOf(data[mapped.variable]))) {
				scheduleWrite(source.id);
			}
		}
	});

	// --------------------------------------------------------------- tracking
	function watch(source: DataSource): void {
		if (source.mode !== "track" || watched.has(source.id)) return;
		watched.set(source.id, source.path);
		fs.watchFile(source.path, { interval: TRACK_INTERVAL_MS }, (current) => {
			if (!find(source.id)) return;
			if (current.mtimeMs === 0) {
				failed(source.id, Object.assign(new Error("The file is gone"), { code: "ENOENT" }));
				return;
			}
			// notGT's own write is not news.
			if (current.mtimeMs === ownWrites.get(source.id)) return;
			void enqueue(source.id, async () => {
				const fresh = find(source.id);
				if (fresh) await read(fresh);
			});
		});
	}

	function unwatch(id: string): void {
		const file = watched.get(id);
		if (file) fs.unwatchFile(file);
		watched.delete(id);
	}

	// ------------------------------------------------------------- connecting
	/**
	 * Connects the workbook at `file`. A workbook that is connected again — the
	 * same tracked path, or a loaded file of the same name — replaces itself and
	 * keeps its variables; anything else that would overwrite an existing
	 * variable is reported instead, unless `replace` says to go ahead.
	 */
	async function connect(input: {
		mode: DataSourceMode;
		name: string;
		file: string;
		replace: boolean;
	}): Promise<Connected> {
		if (!fs.existsSync(input.file) || !fs.statSync(input.file).isFile()) {
			throw new SourceError(404, "missing", `No such file: ${input.file}`);
		}
		let tables: SheetTable[];
		try {
			tables = await readWorkbook(input.file);
		} catch (error) {
			throw new SourceError(400, "unreadable", String((error as Error)?.message ?? error));
		}
		if (tables.length === 0) {
			throw new SourceError(
				400,
				"no_tables",
				"No table found: the first filled row of a sheet must hold the column names",
			);
		}

		const previous = list().find(
			(source) =>
				source.mode === input.mode &&
				(input.mode === "track" ? source.path === input.file : source.name === input.name),
		);
		const base = safeBase(input.name);
		const sheets: DataSourceSheet[] = [];
		for (const table of tables) {
			const wanted =
				previous?.sheets.find((mapped) => mapped.sheet === table.sheet)?.variable ??
				variableName(table.sheet, base, tables.length === 1);
			let variable = wanted;
			for (let n = 2; sheets.some((mapped) => mapped.variable === variable); n += 1) {
				variable = `${wanted}_${n}`;
			}
			sheets.push({ sheet: table.sheet, variable });
		}

		const data = store.readData();
		const own = new Set(previous?.sheets.map((mapped) => mapped.variable) ?? []);
		const conflicts = sheets
			.map((mapped) => mapped.variable)
			.filter((variable) => variable in data && !own.has(variable));
		if (conflicts.length > 0 && !input.replace) return { conflicts };

		const source: DataSource = {
			id: previous?.id ?? newId("src"),
			kind: "excel",
			mode: input.mode,
			name: input.name,
			path: previous?.path ?? input.file,
			sheets,
			state: "ok",
			syncedAt: Date.now(),
		};

		// A variable can mirror one sheet only: other workbooks let go of these.
		const taken = new Set(sheets.map((mapped) => mapped.variable));
		const others = list()
			.filter((other) => other.id !== source.id)
			.map((other) => ({
				...other,
				sheets: other.sheets.filter((mapped) => !taken.has(mapped.variable)),
			}));
		for (const other of others.filter((entry) => entry.sheets.length === 0)) release(other);
		sources.value = [...others.filter((entry) => entry.sheets.length > 0), source];

		return { source };
	}

	/** Stops following a workbook and, for a loaded one, drops its working copy. */
	function release(source: DataSource): void {
		unwatch(source.id);
		clearTimeout(writeTimers.get(source.id));
		writeTimers.delete(source.id);
		ownWrites.delete(source.id);
		for (const mapped of source.sheets) snapshots.delete(mapped.variable);
		if (source.mode === "load") fs.rmSync(source.path, { force: true });
	}

	/** Lets go of a workbook. Its variables stay, as ordinary lists. */
	function disconnect(id: string): boolean {
		const source = find(id);
		if (!source) return false;
		release(source);
		sources.value = list().filter((entry) => entry.id !== id);
		log.info("Data source disconnected: %s", source.name);
		return true;
	}

	async function adopt(source: DataSource): Promise<void> {
		await enqueue(source.id, () => read(source));
		watch(source);
		log.info(
			"Data source connected (%s): %s → %s",
			source.mode,
			source.name,
			source.sheets.map((mapped) => mapped.variable).join(", "),
		);
	}

	// ------------------------------------------------------------------ HTTP
	const router = nodecg.Router() as unknown as Router;

	// Operated from the dashboard, so it is guarded by NodeCG's own session
	// check rather than the API token (the panel has no token and must not
	// need one).
	router.use(authCheck);

	const reply = (res: ApiResponse, error: unknown): void => {
		if (error instanceof SourceError) {
			res.status(error.status).json({ ok: false, error: error.code, message: error.message });
		} else {
			res.status(500).json({ ok: false, error: "failed", message: String(error) });
		}
	};

	const finish = async (res: ApiResponse, outcome: Connected): Promise<void> => {
		if ("conflicts" in outcome) {
			res.status(409).json({ ok: false, error: "conflict", conflicts: outcome.conflicts });
			return;
		}
		await adopt(outcome.source);
		res.status(200).json({ ok: true, source: find(outcome.source.id) });
	};

	router.get("/", (_req: ApiRequest, res: ApiResponse) => {
		res.status(200).json({ sources: list() });
	});

	// Load: the browser posts the bytes of the workbook.
	router.post("/upload", (req: ApiRequest, res: ApiResponse) => {
		const name = path.basename(pickString(req.query["name"]) ?? "workbook.xlsx");
		const replace = pickString(req.query["replace"]) === "1";
		if (!isWorkbookName(name)) {
			res.status(400).json({ ok: false, error: "not_xlsx", message: "Only .xlsx workbooks are read" });
			return;
		}
		const incoming = path.join(dir, `.incoming-${newId("up")}.xlsx`);
		const out = fs.createWriteStream(incoming);
		let received = 0;
		let broken: string | undefined;

		const stream = req as unknown as {
			on(event: string, cb: (...args: unknown[]) => void): void;
			pipe(dest: NodeJS.WritableStream): void;
			destroy(): void;
		};
		stream.on("data", (chunk) => {
			received += (chunk as Buffer).length ?? 0;
			if (received > MAX_UPLOAD_BYTES) {
				broken = "The workbook is larger than 64 MB";
				stream.destroy();
			}
		});
		stream.on("error", (error) => {
			broken = String(error);
			out.destroy();
		});
		out.on("error", (error) => {
			broken = String(error);
		});
		stream.on("end", () => {
			out.end(() => {
				void (async () => {
					try {
						if (broken) throw new SourceError(400, "upload", broken);
						const outcome = await connect({ mode: "load", name, file: incoming, replace });
						if ("source" in outcome) {
							// The working copy: a workbook loaded again takes the place of
							// the one it replaces.
							const home =
								outcome.source.path === incoming
									? path.join(dir, `${safeBase(name)}-${outcome.source.id.slice(-6)}.xlsx`)
									: outcome.source.path;
							fs.renameSync(incoming, home);
							update(outcome.source.id, { path: home });
							outcome.source.path = home;
						}
						await finish(res, outcome);
					} catch (error) {
						reply(res, error);
					} finally {
						fs.rmSync(incoming, { force: true });
					}
				})();
			});
		});
		stream.pipe(out);
	});

	// Track: the workbook stays where it is on the server.
	router.post("/track", (req: ApiRequest, res: ApiResponse) => {
		const body = (req.body ?? {}) as { path?: unknown; replace?: unknown };
		const given = pickString(body.path) ?? pickString(req.query["path"]);
		void (async () => {
			try {
				if (!given) throw new SourceError(400, "bad_request", "The path of the workbook is missing");
				// A pasted Windows path often comes in quotes.
				const file = path.resolve(given.replace(/^["']|["']$/g, ""));
				if (!isWorkbookName(file)) {
					throw new SourceError(400, "not_xlsx", "Only .xlsx workbooks are read");
				}
				const outcome = await connect({
					mode: "track",
					name: path.basename(file),
					file,
					replace: body.replace === true || pickString(req.query["replace"]) === "1",
				});
				await finish(res, outcome);
			} catch (error) {
				reply(res, error);
			}
		})();
	});

	router.post("/:id/reload", (req: ApiRequest, res: ApiResponse) => {
		const source = find(req.params["id"]!);
		if (!source) {
			res.status(404).json({ ok: false, error: "not_found" });
			return;
		}
		void enqueue(source.id, () => read(source)).then(() =>
			res.status(200).json({ ok: true, source: find(source.id) }),
		);
	});

	router.get("/:id/download", (req: ApiRequest, res: ApiResponse) => {
		const source = find(req.params["id"]!);
		if (!source) {
			res.status(404).json({ ok: false, error: "not_found" });
			return;
		}
		// After whatever is still being written.
		void enqueue(source.id, async () => undefined).then(() => {
			(res as unknown as { download(file: string, name: string): void }).download(
				source.path,
				source.name,
			);
		});
	});

	router.delete("/:id", (req: ApiRequest, res: ApiResponse) => {
		if (!disconnect(req.params["id"]!)) {
			res.status(404).json({ ok: false, error: "not_found" });
			return;
		}
		res.status(200).json({ ok: true });
	});

	return {
		router,
		/**
		 * Picks the connections up after a restart. A tracked file may have
		 * changed while the server was down, so it is read; a loaded copy only
		 * ever changes through notGT, so the variables are written to it.
		 */
		start(): void {
			const data = store.readData();
			for (const source of list()) {
				if (source.mode === "track") {
					void enqueue(source.id, () => read(source));
					watch(source);
				} else {
					for (const mapped of source.sheets) {
						snapshots.set(mapped.variable, snapshotOf(data[mapped.variable]));
					}
					void enqueue(source.id, () => write(source));
				}
			}
			if (list().length > 0) log.info("Data sources: %d connected", list().length);
		},
	};
}
