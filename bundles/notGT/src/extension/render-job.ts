import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { RENDER_LOOP_MAX_MS, RENDER_MAX_EXIT_MS, RENDER_MAX_HOLD_MS, type RenderFormat } from "../shared/render";
import { DxvMovWriter } from "./dxv";
import { mediaToolEnv } from "./media-tools";
import { RenderBrowser, type RenderPage } from "./render-browser";

/**
 * One render, from an out page in render mode to a file: shared by the
 * server's Render dialog (extension/render.ts) and the command line
 * (extension/render-cli.ts), which renders another server's animation on the
 * machine it runs on.
 */

export class Cancelled extends Error {}

/** A loop was asked to find its own length, and nothing on air repeats by itself. */
export class NothingLoops extends Error {}

export interface RenderSpec {
	format: RenderFormat;
	fps: number;
	width: number;
	height: number;
	/** "play": the entrance, `holdMs` on screen, the exit. "loop": one cycle of what moves on air. */
	mode: "play" | "loop";
	holdMs: number;
	/** The loop's length; 0 finds it from the animation's own loops. */
	cycleMs: number;
	/** Roughly how long the exit lasts, for the progress. */
	exitMs: number;
}

export interface RenderOutcome {
	frames: number;
	/** A loop: its length, and the most any repeating part is off where the file starts over. */
	cycleMs?: number;
	missMs?: number;
	/** The period of the part that is that far off. */
	missPeriodMs?: number;
	/** When it misses: the length after which every part does come round, if one is not too long. */
	exactMs?: number;
}

export interface RenderHooks {
	progress(frames: number, fraction: number): void;
	cancelled(): boolean;
}

/**
 * Renders the animation the out page at `url` shows in render mode into
 * `file`. `browsers` are tried in turn until one starts.
 */
export async function renderToFile(
	browsers: string[],
	url: string,
	spec: RenderSpec,
	file: string,
	hooks: RenderHooks,
): Promise<RenderOutcome> {
	const browser = await RenderBrowser.launchFirst(browsers);
	const sink: FrameSink = spec.format === "dxv" ? new DxvSink(file, spec) : new FfmpegSink(file, spec);
	try {
		const page = await browser.newPage(spec.width, spec.height);
		const opened = await page.call<{ errorText?: string }>("Page.navigate", { url });
		if (opened.errorText) throw new Error(`cannot open the out page: ${opened.errorText}`);
		await page.waitFor(
			"window.__notgtRender && window.__notgtRender.ready",
			30_000,
			"Opening the out page in render mode (it needs notGT 0.16.0 or newer on the server)",
		);
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
		const outcome = spec.mode === "loop" ? await loop(page, sink, spec, hooks) : await play(page, sink, spec, hooks);
		if (outcome.frames === 0) throw new Error("the animation left before its first frame");
		await sink.finish();
		return outcome;
	} catch (error) {
		await sink.abort();
		throw error;
	} finally {
		await browser.close().catch(() => {});
	}
}

/** The entrance, the time on screen, the exit. */
async function play(page: RenderPage, sink: FrameSink, spec: RenderSpec, hooks: RenderHooks): Promise<RenderOutcome> {
	const frameMs = 1000 / spec.fps;
	const expected = spec.holdMs + spec.exitMs;
	let hideAt: number | null = null;
	let frames = 0;
	for (let index = 0; ; index++) {
		if (hooks.cancelled()) throw new Cancelled();
		const t = index * frameMs;
		if (hideAt === null && t >= spec.holdMs - 1e-6) {
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
		frames = index + 1;
		hooks.progress(frames, Math.min(0.99, (t + frameMs) / (expected + frameMs)));
		await page.evaluate(`window.__notgtClock.step(${frameMs})`);
	}
	return { frames };
}

/** How long a render waits for the entrance to be over before it starts a loop anyway. */
const ENTRANCE_LIMIT_MS = 30_000;

/**
 * One cycle of what moves on air, from where the entrance is over: the last
 * frame leads into the first, so the file plays on in a loop without a jump.
 */
async function loop(page: RenderPage, sink: FrameSink, spec: RenderSpec, hooks: RenderHooks): Promise<RenderOutcome> {
	const frameMs = 1000 / spec.fps;
	let periods: number[] = [];
	for (let t = 0; ; t += frameMs) {
		if (hooks.cancelled()) throw new Cancelled();
		const state = await page.evaluate<{ busy: boolean; periods: number[] }>("window.__notgtClock.loops()");
		periods = state.periods;
		if (!state.busy || t >= ENTRANCE_LIMIT_MS) break;
		await page.evaluate(`window.__notgtClock.step(${frameMs})`);
	}

	let cycle: LoopCycle;
	if (spec.cycleMs > 0) {
		const cycleMs = Math.max(1, Math.round(spec.cycleMs / frameMs)) * frameMs;
		cycle = { cycleMs, ...missOf(periods, cycleMs) };
	} else {
		const found = chooseCycle(periods, frameMs);
		if (!found) {
			throw new NothingLoops("nothing repeats on air by itself (no endless animation or looping video): give the loop a length");
		}
		cycle = found;
	}

	const total = Math.max(1, Math.round(cycle.cycleMs / frameMs));
	for (let index = 0; index < total; index++) {
		if (hooks.cancelled()) throw new Cancelled();
		await sink.add(await page.capture());
		hooks.progress(index + 1, Math.min(0.99, (index + 1) / total));
		await page.evaluate(`window.__notgtClock.step(${frameMs})`);
	}
	const exactMs = cycle.missMs > frameMs / 2 ? exactLoop(periods, frameMs) : undefined;
	return { frames: total, cycleMs: cycle.cycleMs, missMs: cycle.missMs, missPeriodMs: cycle.missPeriodMs, exactMs };
}

/**
 * The length after which every repeating part is back where it began, as a
 * whole number of frames; none when it would last longer than a hold may.
 */
function exactLoop(periods: number[], frameMs: number): number | undefined {
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	let lcm = 1;
	for (const period of periods) {
		const whole = Math.round(period);
		if (whole <= 0) continue;
		lcm = (lcm / gcd(lcm, whole)) * whole;
		if (lcm > RENDER_MAX_HOLD_MS) return undefined;
	}
	return lcm > 1 ? Math.round(lcm / frameMs) * frameMs : undefined;
}

export interface LoopCycle {
	cycleMs: number;
	missMs: number;
	missPeriodMs: number;
}

/** How far, at the most, the repeating parts are from a whole number of their cycles at `cycleMs`. */
function missOf(periods: number[], cycleMs: number): { missMs: number; missPeriodMs: number } {
	let missMs = 0;
	let missPeriodMs = 0;
	for (const period of periods) {
		const rest = cycleMs % period;
		const miss = Math.min(rest, period - rest);
		if (miss > missMs) {
			missMs = miss;
			missPeriodMs = period;
		}
	}
	return { missMs, missPeriodMs };
}

/**
 * The shortest whole number of frames, up to RENDER_LOOP_MAX_MS, after which
 * every repeating part is back where it began: within half a frame, or 1% of
 * a long, slow cycle, where a jump that small does not show. When no length
 * fits, the one that misses the least, as a share of each part's cycle.
 */
export function chooseCycle(periods: number[], frameMs: number, maxMs = RENDER_LOOP_MAX_MS): LoopCycle | null {
	const list = [...new Set(periods.filter((p) => p > 0).map((p) => Math.round(p * 10) / 10))];
	if (list.length === 0) return null;
	const longest = Math.max(...list);
	const first = Math.max(1, Math.ceil(longest / frameMs - 1e-6));
	let best: { cycleMs: number; share: number } | null = null;
	for (let frames = first; frames * frameMs <= maxMs + 1e-6; frames++) {
		const cycleMs = frames * frameMs;
		let fits = true;
		let share = 0;
		for (const period of list) {
			const rest = cycleMs % period;
			const miss = Math.min(rest, period - rest);
			if (miss > Math.max(frameMs / 2, period / 100) + 1e-6) fits = false;
			share = Math.max(share, miss / period);
		}
		if (fits) return { cycleMs, ...missOf(list, cycleMs) };
		if (!best || share < best.share) best = { cycleMs, share };
	}
	const cycleMs = best ? best.cycleMs : first * frameMs;
	return { cycleMs, ...missOf(list, cycleMs) };
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
		private readonly spec: RenderSpec,
	) {}

	async open(): Promise<void> {
		const encode =
			this.spec.format === "webm"
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
			"-f", "image2pipe", "-framerate", String(this.spec.fps), "-c:v", "png", "-i", "pipe:0",
			...encode,
			"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
			"-an",
			"-f", this.spec.format === "webm" ? "webm" : "mov",
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
		private readonly spec: RenderSpec,
	) {
		this.writer = new DxvMovWriter(file, spec.width, spec.height, spec.fps);
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
			{ id, png: bytes, width: this.spec.width, height: this.spec.height },
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
