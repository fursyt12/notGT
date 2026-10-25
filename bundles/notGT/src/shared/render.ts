/**
 * An animation rendered to a video file with an alpha channel: what the Editor
 * asks for and what the server says back.
 *
 * The server opens the out page in render mode (`out.html?render=<id>`) in a
 * headless Chromium, moves its clock one frame at a time, captures each frame
 * with its transparency and encodes them (extension/render.ts).
 */

export type RenderFormat = "webm" | "prores" | "dxv";

export interface RenderFormatInfo {
	label: string;
	ext: string;
	/** Encoded by ffmpeg; a DXV3 file is written by notGT itself. */
	ffmpeg: boolean;
}

export const RENDER_FORMATS: Record<RenderFormat, RenderFormatInfo> = {
	webm: { label: "WebM · VP9", ext: ".webm", ffmpeg: true },
	prores: { label: "MOV · ProRes 4444", ext: ".mov", ffmpeg: true },
	dxv: { label: "MOV · DXV3", ext: ".mov", ffmpeg: false },
};

export const RENDER_FPS = [25, 30, 50, 60] as const;

/** The longest loop a render looks for by itself; one asked for may last as long as a hold. */
export const RENDER_LOOP_MAX_MS = 60_000;

/** The longest time on screen a render takes. */
export const RENDER_MAX_HOLD_MS = 10 * 60_000;

/**
 * How long a render waits for the exit after the hide: a code animation that
 * never calls `hideDone()` is cut there.
 */
export const RENDER_MAX_EXIT_MS = 15_000;

export interface RenderRequest {
	templateId: string;
	format: RenderFormat;
	fps: number;
	/** "play": the entrance, `holdMs` on screen, the exit. "loop": one cycle of what moves on air. */
	mode?: "play" | "loop";
	/** From the show to the start of the exit. */
	holdMs: number;
	/** The loop's length; 0 or none finds it from the animation's own loops. */
	cycleMs?: number;
}

export interface RenderJob {
	id: string;
	templateId: string;
	/** The animation's name. */
	name: string;
	format: RenderFormat;
	fps: number;
	width: number;
	height: number;
	mode: "play" | "loop";
	holdMs: number;
	/** Asked for: 0 finds it. Done: the loop's length. */
	cycleMs: number;
	/** A loop: the most a repeating part is off where the file starts over, and its period. */
	missMs?: number;
	missPeriodMs?: number;
	/** A loop that misses: the length after which every part does come round, when there is one. */
	exactMs?: number;
	state: "running" | "done" | "error" | "cancelled";
	/** 0..1 */
	progress: number;
	/** Frames captured so far. */
	frames: number;
	/** The finished file, served at `/bundles/notGT/render/files/<file>`. */
	file?: string;
	bytes?: number;
	error?: string;
	/** `no_loop`: a loop found nothing that repeats by itself. */
	errorCode?: "no_loop";
	startedAt: number;
	updatedAt: number;
}

export interface RenderStatus {
	/** The browser that draws the frames, or null when none was found. */
	browser: string | null;
	ffmpeg: boolean;
	/** The render running now, or the last one. */
	job: RenderJob | null;
}

/**
 * Put first into a code animation's document on a render: the frame takes the
 * out page's clock, so its timers, requestAnimationFrame, performance.now and
 * Date move only when the renderer steps a frame (extension/render-clock.ts).
 */
export const RENDER_CLOCK_PRELUDE =
	"try{var p=window.parent;if(p!==window&&p.__notgtClock)p.__notgtClock.adopt(window)}catch(e){}";
