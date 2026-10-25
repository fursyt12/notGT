import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { phaseMs } from "../shared/motion";
import {
	RENDER_FORMATS,
	RENDER_FPS,
	RENDER_MAX_HOLD_MS,
	type RenderFormat,
	type RenderJob,
	type RenderStatus,
} from "../shared/render";
import { BUNDLE_NAME, CODE_EXIT_MAX_MS, newId, type TitleTemplate } from "../shared/types";
import type { ApiRequest, ApiResponse, Handler, NextFn } from "./auth";
import { ffmpegAvailable } from "./media-tools";
import { findBrowsers } from "./render-browser";
import { Cancelled, NothingLoops, renderToFile } from "./render-job";
import type { ServerAPI, Store } from "./store";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	delete(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

export interface RenderOptions {
	/** Where finished videos are kept (the assets volume). */
	rendersDir: string;
	sessionCheck: Handler;
	/**
	 * Keys that open the graphics pages while a render runs: the renderer's
	 * browser has no session of its own when the sign-in is on.
	 */
	keys: Set<string>;
}

/** A finished video stays this long, then the next render clears it away. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Renders an animation into a video file with an alpha channel, for the
 * Editor's Render dialog:
 *
 *   GET    /status       the browser and ffmpeg found, the current or last job
 *   POST   /jobs         { templateId, format, fps, mode, holdMs, cycleMs } starts one
 *   GET    /jobs/:id     its progress
 *   DELETE /jobs/:id     stops it
 *   GET    /files/:name  downloads a finished file
 *
 * The out page is opened in render mode in a headless browser on this
 * machine (extension/render-job.ts). One render runs at a time.
 */
export function createRenderRouter(nodecg: ServerAPI, store: Store, options: RenderOptions): unknown {
	const router = nodecg.Router() as unknown as Router;
	const log = nodecg.log;
	const { rendersDir, keys } = options;
	fs.mkdirSync(rendersDir, { recursive: true });

	let current: { job: RenderJob; control: { cancelled: boolean } } | null = null;
	let last: RenderJob | null = null;

	router.use(options.sessionCheck);

	router.get("/status", (_req: ApiRequest, res: ApiResponse) => {
		const status: RenderStatus = {
			browser: findBrowsers()[0] ?? null,
			ffmpeg: ffmpegAvailable(),
			job: current?.job ?? last,
		};
		res.json(status);
	});

	router.post("/jobs", (req: ApiRequest, res: ApiResponse) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const template = typeof body["templateId"] === "string" ? store.getTemplate(body["templateId"]) : undefined;
		const format = body["format"] as RenderFormat;
		const fps = Number(body["fps"]);
		const mode = body["mode"] === "loop" ? "loop" : "play";
		const holdMs = Math.round(Number(body["holdMs"] ?? 0));
		const cycleMs = Math.round(Number(body["cycleMs"] ?? 0));
		if (!template) return refuse(res, 404, "not_found", "No such animation");
		if (!(format in RENDER_FORMATS)) return refuse(res, 400, "bad_request", "Unknown format");
		if (!RENDER_FPS.includes(fps as (typeof RENDER_FPS)[number])) return refuse(res, 400, "bad_request", "Unsupported frame rate");
		if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > RENDER_MAX_HOLD_MS) {
			return refuse(res, 400, "bad_request", "The time on screen is out of range");
		}
		if (!Number.isFinite(cycleMs) || cycleMs < 0 || cycleMs > RENDER_MAX_HOLD_MS) {
			return refuse(res, 400, "bad_request", "The loop length is out of range");
		}
		if (current) return refuse(res, 409, "busy", "A render is already running");
		const browsers = findBrowsers();
		if (browsers.length === 0) {
			return refuse(res, 503, "no_browser", "No Chromium, Chrome or Edge on the server to draw the frames with");
		}
		if (RENDER_FORMATS[format].ffmpeg && !ffmpegAvailable()) {
			return refuse(res, 503, "no_ffmpeg", "ffmpeg is not installed on the server");
		}

		const now = Date.now();
		const job: RenderJob = {
			id: newId("render"),
			templateId: template.id,
			name: template.name,
			format,
			fps,
			width: template.width,
			height: template.height,
			mode,
			holdMs,
			cycleMs,
			state: "running",
			progress: 0,
			frames: 0,
			startedAt: now,
			updatedAt: now,
		};
		const control = { cancelled: false };
		current = { job, control };
		clearOld();
		log.info(
			"Render %s: %s, %s, %d fps, %s",
			job.id,
			template.name,
			format,
			fps,
			mode === "loop" ? "loop" : `${holdMs} ms on screen`,
		);
		void run(job, template, browsers, control).finally(() => {
			last = job;
			current = null;
		});
		res.status(202).json({ ok: true, job });
	});

	router.get("/jobs/:id", (req: ApiRequest, res: ApiResponse) => {
		const job = current?.job.id === req.params["id"] ? current.job : last?.id === req.params["id"] ? last : null;
		if (!job) return refuse(res, 404, "not_found", "No such render");
		res.json({ job });
	});

	router.delete("/jobs/:id", (req: ApiRequest, res: ApiResponse) => {
		if (current?.job.id !== req.params["id"]) return refuse(res, 404, "not_found", "No such render running");
		current.control.cancelled = true;
		res.json({ ok: true });
	});

	router.get("/files/:name", (req: ApiRequest, res: ApiResponse, next: NextFn) => {
		const name = req.params["name"] ?? "";
		const file = path.join(rendersDir, name);
		if (name !== path.basename(name) || name.startsWith(".") || !fs.existsSync(file)) {
			return refuse(res, 404, "not_found", "No such file");
		}
		const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
		res.setHeader("Content-Type", name.endsWith(".webm") ? "video/webm" : "video/quicktime");
		res.setHeader("Content-Length", String(fs.statSync(file).size));
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		);
		pipeline(fs.createReadStream(file), res as unknown as NodeJS.WritableStream).catch(next);
	});

	/** Server address for the browser on this machine. */
	function serverBase(): string {
		const config = nodecg.config as unknown as { host?: string; port?: number; ssl?: { enabled?: boolean } };
		const host = !config.host || config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
		const scheme = config.ssl?.enabled ? "https" : "http";
		return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${config.port ?? 9090}`;
	}

	async function run(
		job: RenderJob,
		template: TitleTemplate,
		browsers: string[],
		control: { cancelled: boolean },
	): Promise<void> {
		const info = RENDER_FORMATS[job.format];
		const partial = path.join(rendersDir, `.${job.id}${info.ext}`);
		const key = crypto.randomBytes(24).toString("base64url");
		keys.add(key);
		const update = (patch: Partial<RenderJob>) => Object.assign(job, patch, { updatedAt: Date.now() });
		const url =
			`${serverBase()}/bundles/${BUNDLE_NAME}/graphics/out.html` +
			`?render=${encodeURIComponent(template.id)}&key=${encodeURIComponent(key)}`;

		try {
			const outcome = await renderToFile(
				browsers,
				url,
				{
					format: job.format,
					fps: job.fps,
					width: job.width,
					height: job.height,
					mode: job.mode,
					holdMs: job.holdMs,
					cycleMs: job.cycleMs,
					exitMs: exitEstimate(template),
				},
				partial,
				{
					progress: (frames, progress) => update({ frames, progress }),
					cancelled: () => control.cancelled,
				},
			);
			const target = uniqueTarget(fileBase(template.name, job), info.ext);
			fs.renameSync(partial, path.join(rendersDir, target));
			update({
				state: "done",
				progress: 1,
				frames: outcome.frames,
				file: target,
				bytes: fs.statSync(path.join(rendersDir, target)).size,
				...(outcome.cycleMs !== undefined
					? {
							cycleMs: outcome.cycleMs,
							missMs: outcome.missMs,
							missPeriodMs: outcome.missPeriodMs,
							exactMs: outcome.exactMs,
						}
					: {}),
			});
			log.info("Render %s done: %s, %d frames", job.id, target, job.frames);
		} catch (error) {
			if (error instanceof Cancelled) {
				update({ state: "cancelled" });
				log.info("Render %s stopped", job.id);
			} else {
				const message = error instanceof Error ? error.message : String(error);
				update({ state: "error", error: message, ...(error instanceof NothingLoops ? { errorCode: "no_loop" as const } : {}) });
				log.warn("Render %s failed: %s", job.id, message);
			}
		} finally {
			keys.delete(key);
		}
	}

	function uniqueTarget(base: string, ext: string): string {
		for (let n = 1; ; n++) {
			const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
			if (!fs.existsSync(path.join(rendersDir, name))) return name;
		}
	}

	/** Clears away finished files older than a day and what a crash left behind. */
	function clearOld(): void {
		try {
			const cutoff = Date.now() - KEEP_MS;
			for (const name of fs.readdirSync(rendersDir)) {
				const file = path.join(rendersDir, name);
				if (name.startsWith(".") || fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
			}
		} catch {
			// Housekeeping is best-effort.
		}
	}

	return router;
}

/** A name for the file: the animation's, its size, the rate, the format, a loop. */
export function fileBase(
	name: string,
	job: Pick<RenderJob, "width" | "height" | "fps" | "format" | "mode">,
): string {
	const base =
		name
			.replace(/[^\p{L}\p{N}._-]+/gu, "_")
			.replace(/^[._-]+|[._-]+$/g, "")
			.slice(0, 60) || "render";
	const kind = job.format === "webm" ? "" : `-${job.format}`;
	const loop = job.mode === "loop" ? "-loop" : "";
	return `${base}-${job.width}x${job.height}-${job.fps}fps${kind}${loop}`;
}

function refuse(res: ApiResponse, status: number, error: string, message: string): void {
	res.status(status).json({ error, message });
}

/** Roughly how long the exit lasts, for the progress bar. */
export function exitEstimate(template: TitleTemplate): number {
	if (template.kind === "code") return Math.min(CODE_EXIT_MAX_MS, template.code?.exitMs || 600);
	return phaseMs(template, "out");
}
