import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { newId } from "../shared/types";
import type { ApiRequest, ApiResponse, Handler, NextFn } from "./auth";
import type { ServerAPI } from "./store";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	delete(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

export interface MediaJob {
	id: string;
	state: "converting" | "done" | "error";
	/** 0..1 */
	progress: number;
	message: string;
	originalName: string;
	src?: string;
	file?: string;
	format?: string;
	bytes?: number;
	inputBytes?: number;
	error?: string;
	startedAt: number;
	updatedAt: number;
}

/** Extensions that a browser source can already play, so no conversion is needed. */
const BROWSER_READY = new Set([
	".webm",
	".webp",
	".gif",
	".png",
	".apng",
	".jpg",
	".jpeg",
	".svg",
]);

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;

/** Keeps a filename safe for the filesystem without mangling non-Latin names. */
function safeBase(name: string): string {
	const base = path.basename(name, path.extname(name));
	const cleaned = base
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 60);
	return cleaned || "media";
}

function safeExt(name: string): string {
	const ext = path.extname(name).toLowerCase();
	return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
}

function pickString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return undefined;
}

function fileSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

function ffmpegAvailable(): boolean {
	const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
	return res.status === 0;
}

/**
 * Drag-and-drop media pipeline for the `video` layer.
 *
 * The browser posts the raw file bytes; the server writes them to a temp file,
 * then either moves browser-ready formats straight into the media directory or
 * runs `scripts/convert-alpha.mjs` over them (streaming its JSON progress back
 * to the panel through the job record). Finished files land in the NodeCG
 * assets tree, so they live in the `assets` volume and survive a container
 * rebuild.
 */
export function createMediaRouter(
	nodecg: ServerAPI,
	mediaDir: string,
	urlPrefix: string,
	authCheck: Handler,
): unknown {
	const router = nodecg.Router() as unknown as Router;
	const log = nodecg.log;
	const jobs = new Map<string, MediaJob>();
	// Same filesystem as mediaDir on purpose: /tmp may be a separate tmpfs and
	// rename() across devices fails with EXDEV.
	const tmpDir = path.join(path.dirname(mediaDir), ".tmp");
	const cliPath = path.resolve(__dirname, "..", "scripts", "convert-alpha.mjs");

	fs.mkdirSync(mediaDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });

	// Drop leftovers from an interrupted upload (older than a day).
	try {
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const name of fs.readdirSync(tmpDir)) {
			const full = path.join(tmpDir, name);
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		}
	} catch {
		// Housekeeping is best-effort.
	}

	// Everything here is operated from the dashboard, so it is guarded by
	// NodeCG's own session check rather than the API token (the panel has no
	// token and must not need one).
	router.use(authCheck);

	const prune = (): void => {
		const now = Date.now();
		for (const [id, job] of jobs) {
			if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
		}
	};

	// ------------------------------------------------------------- jobs
	router.get("/jobs/:id", (req: ApiRequest, res: ApiResponse) => {
		prune();
		const job = jobs.get(req.params["id"]!);
		if (!job) {
			res.status(404).json({ error: "not_found", message: "Unknown job" });
			return;
		}
		res.status(200).json({ job });
	});

	// ------------------------------------------------------------- list
	router.get("/list", (_req: ApiRequest, res: ApiResponse) => {
		let files: Array<{ name: string; src: string; bytes: number; mtime: number }> = [];
		try {
			files = fs
				.readdirSync(mediaDir)
				.filter((name) => !name.startsWith("."))
				.map((name) => {
					const full = path.join(mediaDir, name);
					const stat = fs.statSync(full);
					return {
						name,
						src: `${urlPrefix}${encodeURIComponent(name)}`,
						bytes: stat.size,
						mtime: stat.mtimeMs,
					};
				})
				.filter((entry) => entry.bytes > 0)
				.sort((a, b) => b.mtime - a.mtime);
		} catch (error) {
			log.warn("Could not list %s: %s", mediaDir, String(error));
		}
		res.status(200).json({ dir: mediaDir, urlPrefix, files });
	});

	// ----------------------------------------------------------- delete
	router.delete("/file/:name", (req: ApiRequest, res: ApiResponse) => {
		const name = path.basename(req.params["name"]!);
		const full = path.join(mediaDir, name);
		if (!full.startsWith(mediaDir + path.sep)) {
			res.status(400).json({ error: "bad_request", message: "Invalid name" });
			return;
		}
		try {
			fs.unlinkSync(full);
			res.status(200).json({ ok: true, name });
		} catch (error) {
			res.status(404).json({ error: "not_found", message: String(error) });
		}
	});

	// ----------------------------------------------------------- upload
	router.post("/upload", (req: ApiRequest, res: ApiResponse) => {
		prune();
		const originalName = pickString(req.query["name"]) ?? "upload.bin";
		const ext = safeExt(originalName);
		const base = safeBase(originalName);
		const short = newId("m").slice(-6);
		const stem = `${base}-${short}`;
		const tmpFile = path.join(tmpDir, `${stem}${ext}`);

		const job: MediaJob = {
			id: newId("job"),
			state: "converting",
			progress: 0,
			message: "Приём файла",
			originalName,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		jobs.set(job.id, job);

		const out = fs.createWriteStream(tmpFile);
		let received = 0;
		let failed: string | undefined;

		const stream = req as unknown as {
			on(event: string, cb: (...args: unknown[]) => void): void;
			pipe(dest: NodeJS.WritableStream): void;
			destroy(): void;
		};

		stream.on("data", (chunk) => {
			received += (chunk as Buffer).length ?? 0;
			if (received > MAX_UPLOAD_BYTES) {
				failed = "Файл больше 2 ГБ";
				stream.destroy();
			}
		});
		stream.on("error", (error) => {
			failed = String(error);
			out.destroy();
		});
		out.on("error", (error) => {
			failed = String(error);
		});
		stream.on("end", () => {
			out.end(() => {
				if (failed) {
					job.state = "error";
					job.error = failed;
					job.message = failed;
					job.updatedAt = Date.now();
					res.status(400).json({ ok: false, jobId: job.id, error: failed });
					return;
				}
				job.inputBytes = received;
				job.updatedAt = Date.now();
				res.status(202).json({ ok: true, jobId: job.id, bytes: received });
				void processJob(job, tmpFile, ext, stem);
			});
		});
		stream.pipe(out);
	});

	// ------------------------------------------------------------------
	async function processJob(
		job: MediaJob,
		tmpFile: string,
		ext: string,
		stem: string,
	): Promise<void> {
		try {
			if (BROWSER_READY.has(ext)) {
				// Already playable in a browser source: just publish it.
				job.message = "Публикация";
				job.progress = 0.5;
				const target = await uniqueTarget(`${stem}${ext}`);
				await moveFile(tmpFile, target);
				finish(job, target, ext.replace(".", ""));
				return;
			}

			if (!ffmpegAvailable()) {
				throw new Error(
					"ffmpeg не найден на сервере. Установите его в образ (Dockerfile уже " +
						"ставит ffmpeg) либо конвертируйте файл локально командой " +
						"`node scripts/convert-alpha.mjs` и загрузите готовый .webm/.webp.",
				);
			}

			job.message = "Конвертация";
			const outPath = await runConverter(job, tmpFile);
			finish(job, outPath.file, outPath.format);
		} catch (error) {
			job.state = "error";
			job.error = String((error as Error)?.message ?? error);
			job.message = job.error;
			job.updatedAt = Date.now();
			log.warn("Media job %s failed: %s", job.id, job.error);
		} finally {
			void fs.promises.rm(tmpFile, { force: true }).catch(() => {});
		}
	}

	function finish(job: MediaJob, file: string, format: string): void {
		const name = path.basename(file);
		job.state = "done";
		job.progress = 1;
		job.message = "Готово";
		job.file = file;
		job.format = format;
		job.bytes = fileSize(file);
		job.src = `${urlPrefix}${encodeURIComponent(name)}`;
		job.updatedAt = Date.now();
		log.info("Media ready: %s (%s, %d bytes)", job.src, format, job.bytes ?? 0);
	}

	/** Moves a file, falling back to copy+unlink across filesystems. */
	async function moveFile(from: string, to: string): Promise<void> {
		try {
			await fs.promises.rename(from, to);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			await fs.promises.copyFile(from, to);
			await fs.promises.rm(from, { force: true });
		}
	}

	/** Avoids clobbering an existing file with the same name. */
	async function uniqueTarget(name: string): Promise<string> {
		const ext = path.extname(name);
		const base = path.basename(name, ext);
		let candidate = path.join(mediaDir, name);
		let counter = 2;
		while (fs.existsSync(candidate)) {
			candidate = path.join(mediaDir, `${base}-${counter++}${ext}`);
		}
		return candidate;
	}

	/**
	 * Spawns the converter CLI and forwards its `{"type":"progress"}` /
	 * `{"type":"done"}` stdout lines into the job record.
	 */
	function runConverter(
		job: MediaJob,
		input: string,
	): Promise<{ file: string; format: string }> {
		return new Promise((resolve, reject) => {
			const args = [
				cliPath,
				input,
				"--out",
				mediaDir,
				"--json-progress",
				"--url-prefix",
				urlPrefix,
			];
			const child = spawn(process.execPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let done: { file: string; format: string } | undefined;
			let stderrTail = "";

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let payload: Record<string, unknown>;
					try {
						payload = JSON.parse(line);
					} catch {
						continue;
					}
					if (payload["type"] === "progress") {
						const percent = Number(payload["percent"]);
						if (Number.isFinite(percent)) {
							// Conversion is most of the work; keep a little room so the
							// bar never sits at 100% before the file is published.
							job.progress = Math.min(0.99, percent / 100);
							job.message = `Конвертация ${Math.round(percent)}%`;
							job.updatedAt = Date.now();
						}
					} else if (payload["type"] === "done") {
						done = {
							file: String(payload["file"]),
							format: String(payload["format"] ?? ""),
						};
					} else if (payload["type"] === "error") {
						stderrTail = String(payload["message"] ?? "conversion failed");
					}
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderrTail = `${stderrTail}${chunk}`.slice(-800);
			});
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code === 0 && done) resolve(done);
				else {
					reject(
						new Error(
							`Конвертация не удалась (код ${code}). ${stderrTail.trim().split("\n").pop() ?? ""}`,
						),
					);
				}
			});
		});
	}

	return router;
}
