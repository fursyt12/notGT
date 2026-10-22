import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";

import { phaseMs } from "../shared/motion";
import {
	RENDER_FORMATS,
	RENDER_FPS,
	RENDER_MAX_EXIT_MS,
	RENDER_MAX_HOLD_MS,
	type RenderFormat,
	type RenderJob,
	type RenderStatus,
} from "../shared/render";
import { BUNDLE_NAME, CODE_EXIT_MAX_MS, newId, type TitleTemplate } from "../shared/types";
import type { ApiRequest, ApiResponse, Handler, NextFn } from "./auth";
import { DxvMovWriter } from "./dxv";
import { ffmpegAvailable, mediaToolEnv } from "./media-tools";
import { findBrowser, RenderBrowser } from "./render-browser";
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

class Cancelled extends Error {}

/**
 * Renders an animation into a video file with an alpha channel, for the
 * Editor's Render dialog:
 *
 *   GET    /status       the browser and ffmpeg found, the current or last job
 *   POST   /jobs         { templateId, format, fps, holdMs } starts one
 *   GET    /jobs/:id     its progress
 *   DELETE /jobs/:id     stops it
 *   GET    /files/:name  downloads a finished file
 *
 * The out page is opened in render mode in a headless browser on this
 * machine. Its clock is stopped and moved one frame at a time; each frame is
 * captured with its transparency and goes to ffmpeg (WebM VP9, ProRes 4444)
 * or to the DXV3 writer. One render runs at a time.
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
			browser: findBrowser(),
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
		const holdMs = Math.round(Number(body["holdMs"]));
		if (!template) return refuse(res, 404, "not_found", "No such animation");
		if (!(format in RENDER_FORMATS)) return refuse(res, 400, "bad_request", "Unknown format");
		if (!RENDER_FPS.includes(fps as (typeof RENDER_FPS)[number])) return refuse(res, 400, "bad_request", "Unsupported frame rate");
		if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > RENDER_MAX_HOLD_MS) {
			return refuse(res, 400, "bad_request", "The time on screen is out of range");
		}
		if (current) return refuse(res, 409, "busy", "A render is already running");
		const browser = findBrowser();
		if (!browser) {
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
			holdMs,
			state: "running",
			progress: 0,
			frames: 0,
			startedAt: now,
			updatedAt: now,
		};
		const control = { cancelled: false };
		current = { job, control };
		clearOld();
		log.info("Render %s: %s, %s, %d fps, %d ms on screen", job.id, template.name, format, fps, holdMs);
		void run(job, template, browser, control).finally(() => {
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
		executable: string,
		control: { cancelled: boolean },
	): Promise<void> {
		const info = RENDER_FORMATS[job.format];
		const partial = path.join(rendersDir, `.${job.id}${info.ext}`);
		const key = crypto.randomBytes(24).toString("base64url");
		keys.add(key);
		let browser: RenderBrowser | null = null;
		const sink = job.format === "dxv" ? new DxvSink(partial, job) : new FfmpegSink(partial, job);
		const update = (patch: Partial<RenderJob>) => Object.assign(job, patch, { updatedAt: Date.now() });

		try {
			browser = await RenderBrowser.launch(executable);
			const page = await browser.newPage(job.width, job.height);
			const url =
				`${serverBase()}/bundles/${BUNDLE_NAME}/graphics/out.html` +
				`?render=${encodeURIComponent(template.id)}&key=${encodeURIComponent(key)}`;
			const opened = await page.call<{ errorText?: string }>("Page.navigate", { url });
			if (opened.errorText) throw new Error(`cannot open the out page: ${opened.errorText}`);
			await page.waitFor("window.__notgtRender && window.__notgtRender.ready", 30_000, "Opening the out page");
			if (!(await page.evaluate<boolean>("window.__notgtRender.hasTemplate()"))) {
				throw new Error("the animation is not on the server any more");
			}

			// From here on the page's time moves only frame by frame.
			await page.evaluate("window.__notgtClock.freeze()");
			await page.call("Animation.enable");
			await page.call("Animation.setPlaybackRate", { playbackRate: 0 });
			await page.evaluate("window.__notgtRender.show()");
			await page.waitFor("window.__notgtRender.loaded()", 30_000, "Loading the animation");
			await page.evaluate("window.__notgtClock.settle().then(() => window.__notgtClock.mark())");

			await sink.open();
			const frameMs = 1000 / job.fps;
			const expected = job.holdMs + exitEstimate(template);
			let hideAt: number | null = null;
			for (let index = 0; ; index++) {
				if (control.cancelled) throw new Cancelled();
				const t = index * frameMs;
				if (hideAt === null && t >= job.holdMs - 1e-6) {
					// The exit starts in the animation's frame on a posted message:
					// give it that moment, then count its animations from here.
					await page.evaluate(
						"(window.__notgtRender.hide(), window.__notgtClock.wait(30)).then(() => window.__notgtClock.mark())",
					);
					hideAt = t;
				}
				if (hideAt !== null) {
					if (t - hideAt > RENDER_MAX_EXIT_MS) break;
					if (!(await page.evaluate<boolean>("window.__notgtRender.onAir()"))) break;
				}
				await sink.add(await page.capture());
				update({ frames: index + 1, progress: Math.min(0.99, (t + frameMs) / (expected + frameMs)) });
				await page.evaluate(`window.__notgtClock.step(${frameMs})`);
			}
			if (job.frames === 0) throw new Error("the animation left before its first frame");
			await sink.finish();

			const target = uniqueTarget(fileBase(template.name, job), info.ext);
			fs.renameSync(partial, path.join(rendersDir, target));
			update({ state: "done", progress: 1, file: target, bytes: fs.statSync(path.join(rendersDir, target)).size });
			log.info("Render %s done: %s, %d frames", job.id, target, job.frames);
		} catch (error) {
			await sink.abort();
			if (error instanceof Cancelled) {
				update({ state: "cancelled" });
				log.info("Render %s stopped", job.id);
			} else {
				const message = error instanceof Error ? error.message : String(error);
				update({ state: "error", error: message });
				log.warn("Render %s failed: %s", job.id, message);
			}
		} finally {
			keys.delete(key);
			await browser?.close().catch(() => {});
		}
	}

	/** A name for the file: the animation's, its size, the rate and the format. */
	function fileBase(name: string, job: RenderJob): string {
		const base =
			name
				.replace(/[^\p{L}\p{N}._-]+/gu, "_")
				.replace(/^[._-]+|[._-]+$/g, "")
				.slice(0, 60) || "render";
		const kind = job.format === "webm" ? "" : `-${job.format}`;
		return `${base}-${job.width}x${job.height}-${job.fps}fps${kind}`;
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

function refuse(res: ApiResponse, status: number, error: string, message: string): void {
	res.status(status).json({ error, message });
}

/** Roughly how long the exit lasts, for the progress bar. */
function exitEstimate(template: TitleTemplate): number {
	if (template.kind === "code") return Math.min(CODE_EXIT_MAX_MS, template.code?.exitMs || 600);
	return phaseMs(template, "out");
}

interface FrameSink {
	open(): Promise<void>;
	add(png: Buffer): Promise<void>;
	finish(): Promise<void>;
	abort(): Promise<void>;
}

/** WebM VP9 and ProRes 4444, by ffmpeg, from the PNG frames on its stdin. */
class FfmpegSink implements FrameSink {
	private child: ReturnType<typeof spawn> | null = null;
	private exited: Promise<number | null> | null = null;
	private stderr = "";

	constructor(
		private readonly file: string,
		private readonly job: RenderJob,
	) {}

	async open(): Promise<void> {
		const encode =
			this.job.format === "webm"
				? [
						"-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p",
						"-c:v", "libvpx-vp9",
						"-pix_fmt", "yuva420p",
						// Without this libvpx refuses to encode transparency at all.
						"-auto-alt-ref", "0",
						"-b:v", "0",
						"-crf", "18",
						"-row-mt", "1",
						"-deadline", "good",
						"-cpu-used", "2",
					]
				: [
						"-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le",
						"-c:v", "prores_ks",
						"-profile:v", "4",
						"-pix_fmt", "yuva444p10le",
						"-alpha_bits", "16",
						"-vendor", "apl0",
					];
		const args = [
			"-hide_banner", "-loglevel", "error", "-y",
			"-f", "image2pipe", "-framerate", String(this.job.fps), "-c:v", "png", "-i", "pipe:0",
			...encode,
			"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
			"-an",
			"-f", this.job.format === "webm" ? "webm" : "mov",
			this.file,
		];
		const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"], env: mediaToolEnv() });
		this.child = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-4000);
		});
		child.stdin?.on("error", () => {
			// A closed pipe shows as ffmpeg's exit code below.
		});
		this.exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code));
		});
	}

	async add(png: Buffer): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || this.child?.exitCode !== null) throw this.failure();
		if (!stdin.write(png)) {
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					stdin.off("drain", done);
					this.child?.off("exit", done);
					if (this.child?.exitCode !== null) reject(this.failure());
					else resolve();
				};
				stdin.once("drain", done);
				this.child?.once("exit", done);
			});
		}
	}

	async finish(): Promise<void> {
		this.child?.stdin?.end();
		const code = await this.exited;
		if (code !== 0) throw this.failure();
	}

	async abort(): Promise<void> {
		this.child?.kill("SIGKILL");
		await this.exited?.catch(() => null);
		fs.rmSync(this.file, { force: true });
	}

	private failure(): Error {
		const reason = this.stderr.trim().split("\n").slice(-2).join(" ");
		return new Error(`ffmpeg stopped${reason ? `: ${reason}` : ""}`);
	}
}

/** DXV3, encoded in worker threads and written in order. */
class DxvSink implements FrameSink {
	private readonly writer: DxvMovWriter;
	private readonly workers: Worker[] = [];
	private readonly waiting = new Map<number, { resolve(packet: Uint8Array): void; reject(error: Error): void }>();
	private queue: Array<Promise<Uint8Array>> = [];
	private next = 0;

	constructor(
		file: string,
		private readonly job: RenderJob,
	) {
		this.writer = new DxvMovWriter(file, job.width, job.height, job.fps);
	}

	async open(): Promise<void> {
		await this.writer.open();
		// Leaves a core or two to the show itself and to the browser.
		const count = Math.max(1, Math.min(4, os.cpus().length - 2));
		const script = path.join(__dirname, "render-worker.js");
		for (let i = 0; i < count; i++) {
			const worker = new Worker(script);
			worker.on("message", (message: { id: number; packet?: Uint8Array; error?: string }) => {
				const waiting = this.waiting.get(message.id);
				if (!waiting) return;
				this.waiting.delete(message.id);
				if (message.packet) waiting.resolve(message.packet);
				else waiting.reject(new Error(`DXV encoding failed: ${message.error ?? "unknown"}`));
			});
			worker.on("error", (error) => {
				for (const waiting of this.waiting.values()) waiting.reject(error);
				this.waiting.clear();
			});
			this.workers.push(worker);
		}
	}

	async add(png: Buffer): Promise<void> {
		const id = this.next++;
		const done = new Promise<Uint8Array>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
		// Awaited in turn by writeOldest(); one dropped by abort() must not crash the server.
		done.catch(() => {});
		const bytes = new Uint8Array(png);
		this.workers[id % this.workers.length]!.postMessage(
			{ id, png: bytes, width: this.job.width, height: this.job.height },
			[bytes.buffer as ArrayBuffer],
		);
		this.queue.push(done);
		// A few frames in flight per worker; the oldest is written first.
		while (this.queue.length >= this.workers.length * 2) await this.writeOldest();
	}

	async finish(): Promise<void> {
		while (this.queue.length > 0) await this.writeOldest();
		await this.writer.close();
		await this.stop();
	}

	async abort(): Promise<void> {
		await this.stop();
		await this.writer.abort();
	}

	private async writeOldest(): Promise<void> {
		const packet = await this.queue.shift()!;
		await this.writer.add(packet);
	}

	private async stop(): Promise<void> {
		this.queue = [];
		await Promise.all(this.workers.map((worker) => worker.terminate()));
		this.workers.length = 0;
	}
}
