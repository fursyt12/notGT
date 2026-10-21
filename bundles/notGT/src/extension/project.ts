import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { version as BUNDLE_VERSION } from "../../package.json";
import {
	BUNDLE_NAME,
	newId,
	SCHEMA_VERSION,
	type Out,
	type TitleData,
	type TitleTemplate,
} from "../shared/types";
import { type ApiRequest, type Handler, isCrossSite } from "./auth";
import {
	copyNgtMedia,
	encodeNgt,
	hashFile,
	NgtError,
	readNgt,
	type NgtMediaEntry,
	type NgtMediaSource,
	type NgtProject,
} from "./ngt";
import type { ServerAPI, Store } from "./store";
import type { Team } from "./team";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

/** A project carries its videos, so it may be large; this only stops a runaway upload. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;
/** A download name that needs no quoting in a header. */
const SAFE_FILE_NAME = /^[\w.-]{1,120}\.ngt$/;

export interface ProjectOptions {
	/** Where the media the animations use lives, and the URL it is served under. */
	mediaDir: string;
	mediaUrlPrefix: string;
	/** NodeCG's session check: the panels have no API token. */
	sessionCheck: Handler;
	/** Saving and opening are an administrator's: a member sees only some of the outs. */
	team: Pick<Team, "roleOf">;
	/** The variables a connected workbook mirrors: the workbook stays their master. */
	boundVariables(): string[];
	/** Takes everything off air: what plays by itself, and what was shown by hand. */
	offAir(): void;
}

/** What opening a project did, for the panel to tell. */
export interface Opened {
	titles: number;
	outs: number;
	variables: number;
	media: {
		added: number;
		reused: number;
		/** [name in the file, name it was given here]: a different file already had the name. */
		renamed: Array<[string, string]>;
	};
	/** Lists a connected workbook mirrors: they keep what the workbook says. */
	kept: string[];
}

class UploadError extends Error {}

/** A media file name as the media folder has them: no folders, nothing hidden. */
function isMediaName(name: string): boolean {
	return (
		name !== "" &&
		name.length <= 255 &&
		name === path.basename(name) &&
		!name.startsWith(".") &&
		!/[\0\\/]/.test(name)
	);
}

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** Every string in a JSON value, passed through `map`. */
function mapStrings<T>(value: T, map: (text: string) => string): T {
	if (typeof value === "string") return map(value) as T;
	if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
		) as T;
	}
	return value;
}

/** `2026-10-21-1530`, the server's local time. */
function stamp(date = new Date()): string {
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

/**
 * The show as one file (the format is in `ngt.ts`).
 *
 *   GET  /save  the `.ngt` file of this server: every animation, out and
 *               variable, and the media files the animations and the
 *               variables point at
 *   POST /open  the bytes of a `.ngt` file. It replaces every animation, out
 *               and variable here and takes everything off air; its media
 *               goes into the media folder
 *
 * Like the Team panel's routes it answers our own pages only, signed in, and
 * an administrator only.
 */
export function createProjectRouter(nodecg: ServerAPI, store: Store, options: ProjectOptions): unknown {
	const router = nodecg.Router() as unknown as Router;
	const log = nodecg.log;
	const { mediaDir, mediaUrlPrefix } = options;
	// Next to the media folder, as the media uploads have it.
	const tmpDir = path.join(path.dirname(mediaDir), ".tmp");
	const prefix = mediaUrlPrefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	/** `/assets/notGT/media/<name>` wherever it is written: a layer, a stylesheet, a variable. */
	const mediaRef = (): RegExp => new RegExp(`${prefix}([^"'\\s()<>?#\\\\]+)`, "g");

	const who = (req: ApiRequest): string | null =>
		(req as unknown as { user?: { name?: string } }).user?.name ?? null;

	router.use((req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		if (isCrossSite(req)) {
			res.status(403).json({ error: "forbidden", message: "Projects are saved and opened from the dashboard" });
			return;
		}
		next();
	});
	router.use(options.sessionCheck);
	router.use((req, res, next) => {
		if (options.team.roleOf(who(req)) === "admin") {
			next();
			return;
		}
		res.status(403).json({ error: "forbidden", message: "Only an administrator saves and opens projects" });
	});

	/** The media files in the folder that these values point at. */
	function mediaOf(values: unknown[]): NgtMediaSource[] {
		const names = new Set<string>();
		for (const value of values) {
			mapStrings(value, (text) => {
				for (const match of text.matchAll(mediaRef())) names.add(decode(match[1]!));
				return text;
			});
		}
		const found: NgtMediaSource[] = [];
		for (const name of names) {
			if (!isMediaName(name)) continue;
			const file = path.join(mediaDir, name);
			try {
				if (fs.statSync(file).isFile()) found.push({ name, file });
			} catch {
				// Pointed at, but not here: there is nothing to carry.
			}
		}
		return found;
	}

	router.get("/save", (req, res) => {
		const titles = store.listTemplates();
		const data = store.readData();
		const media = mediaOf([titles, data]);
		const project: NgtProject = {
			info: {
				app: BUNDLE_NAME,
				version: BUNDLE_VERSION,
				schemaVersion: SCHEMA_VERSION,
				savedAt: new Date().toISOString(),
				titles: titles.length,
				outs: store.listOuts().length,
				variables: Object.keys(data).length,
				media: media.length,
			},
			titles,
			outs: store.listOuts(),
			data,
			selection: store.readSelection(),
		};
		res.setHeader("Content-Type", "application/octet-stream");
		// The panel names the file in the operator's time; the server's clock may be another zone's.
		const asked = req.query["name"];
		const name = typeof asked === "string" && SAFE_FILE_NAME.test(asked) ? asked : `notGT-${stamp()}.ngt`;
		res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
		pipeline(Readable.from(encodeNgt(project, media)), res as unknown as NodeJS.WritableStream).catch(
			(error: unknown) => {
				// The headers are gone already; the file the browser gets has no DONE, so it is not opened.
				log.warn("Saving the project failed: %s", String(error));
			},
		);
	});

	/** True when the media folder has this very file under this name already. */
	async function alreadyHere(target: string, entry: NgtMediaEntry): Promise<boolean> {
		try {
			const stat = fs.statSync(target);
			return stat.isFile() && stat.size === entry.bytes && (await hashFile(target)) === entry.sha256;
		} catch {
			return false;
		}
	}

	/** `name-2.ext`, `name-3.ext`… whichever the media folder does not have yet. */
	function freeName(name: string): string {
		const ext = path.extname(name);
		const base = path.basename(name, ext);
		for (let n = 2; ; n++) {
			const candidate = `${base}-${n}${ext}`;
			if (!fs.existsSync(path.join(mediaDir, candidate))) return candidate;
		}
	}

	async function open(file: string): Promise<Opened> {
		// The whole file is read and checked first: a damaged one changes nothing.
		const { project, media } = await readNgt(file);
		for (const entry of media) {
			if (!isMediaName(entry.name)) throw new NgtError("damaged", `A media file has a name notGT does not write: ${entry.name}`);
		}

		// The media next, so the animations find their files once they are back.
		fs.mkdirSync(mediaDir, { recursive: true });
		const renames = new Map<string, string>();
		let added = 0;
		let reused = 0;
		for (const entry of media) {
			let target = path.join(mediaDir, entry.name);
			if (await alreadyHere(target, entry)) {
				reused++;
				continue;
			}
			if (fs.existsSync(target)) {
				const name = freeName(entry.name);
				renames.set(entry.name, name);
				target = path.join(mediaDir, name);
			}
			const part = path.join(mediaDir, `.${newId("ngt")}.part`);
			try {
				await copyNgtMedia(file, entry, part);
				fs.renameSync(part, target);
			} finally {
				fs.rmSync(part, { force: true });
			}
			added++;
		}
		const renamed = (text: string): string =>
			text.replace(mediaRef(), (whole, name: string) => {
				const to = renames.get(decode(name));
				return to ? `${mediaUrlPrefix}${encodeURIComponent(to)}` : whole;
			});
		const titles: TitleTemplate[] = renames.size > 0 ? mapStrings(project.titles, renamed) : project.titles;
		const data: TitleData = renames.size > 0 ? mapStrings(project.data, renamed) : { ...project.data };

		// A list that mirrors a connected workbook follows the workbook: taking
		// the file's version would write it into the workbook.
		const current = store.readData();
		const kept = options.boundVariables().filter((name) => name in current);
		for (const name of kept) data[name] = current[name];

		// Opening never puts anything on air: what the file had switched on comes
		// back switched off, and a placement whose animation is missing is dropped.
		const ids = new Set(titles.map((title) => title.id));
		const outs: Out[] = project.outs.map((out) => ({
			...out,
			items: out.items.filter((item) => ids.has(item.templateId)).map((item) => ({ ...item, held: false })),
		}));

		options.offAir();
		store.templates.value = titles;
		store.outs.value = outs;
		store.titleData.value = data;
		store.selection.value = project.selection;
		const shown = store.activeTitle.value?.templateId;
		if (shown && !ids.has(shown)) store.resetActive();

		return {
			titles: titles.length,
			outs: outs.length,
			variables: Object.keys(data).length,
			media: { added, reused, renamed: [...renames] },
			kept,
		};
	}

	router.post("/open", (req, res) => {
		fs.mkdirSync(tmpDir, { recursive: true });
		const incoming = path.join(tmpDir, `${newId("ngt")}.ngt`);
		let received = 0;
		const limit = new Transform({
			transform(piece: Buffer, _encoding, done) {
				received += piece.length;
				done(received > MAX_UPLOAD_BYTES ? new UploadError("The file is larger than 16 GB") : null, piece);
			},
		});
		void (async () => {
			try {
				await pipeline(req as unknown as NodeJS.ReadableStream, limit, fs.createWriteStream(incoming));
				const opened = await open(incoming);
				log.info(
					"Project opened: %d animation(s), %d out(s), %d variable(s), %d media file(s) added",
					opened.titles,
					opened.outs,
					opened.variables,
					opened.media.added,
				);
				res.status(200).json({ ok: true, ...opened });
			} catch (error) {
				if (error instanceof NgtError) {
					res.status(400).json({ ok: false, error: error.problem, message: error.message });
				} else if (error instanceof UploadError) {
					res.status(413).json({ ok: false, error: "too_large", message: error.message });
				} else {
					log.warn("Opening a project failed: %s", String(error));
					res.status(500).json({ ok: false, error: "failed", message: String((error as Error)?.message ?? error) });
				}
			} finally {
				fs.rmSync(incoming, { force: true });
			}
		})();
	});

	return router;
}
