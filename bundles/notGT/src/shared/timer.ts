/**
 * Timers: a countdown or a stopwatch the operator starts, pauses and resets,
 * whose value every title can read as variables.
 *
 * The server keeps a timer as *when it started and how much it had counted
 * before*, never as a ticking number: the `timers` Replicant changes only when
 * someone presses a button. Every page — an out in OBS, a dashboard panel —
 * works the current value out for itself from the server's clock (see
 * `ServerClock`), so a timer shows the same second everywhere without the
 * server sending a frame per tick.
 *
 * In a title a timer is a group of variables under `timer.<key>`:
 *
 *   {{timer.match.text}}          "04:59", in the timer's own format
 *   {{timer.match.mm}}:{{timer.match.ss}}
 *   timer.match.progress          0 → 1 over the duration
 *
 * Shared by the extension, the dashboard panels and the out page: no runtime
 * dependency here.
 */
import { slugify, type TitleTemplate } from "./types";

/** The variable every timer lives under: `{{timer.<key>.text}}`. */
export const TIMER_VAR = "timer";

/** `down` counts from the duration to zero; `up` counts from zero. */
export type TimerMode = "down" | "up";

/**
 *   auto      — 04:59, and 1:04:59 once there are hours;
 *   hh:mm:ss  — always with hours: 00:04:59;
 *   mm:ss     — minutes past 59 keep counting: 75:00;
 *   ss        — whole seconds only: 299;
 *   mm:ss.t   — with tenths: 04:59.3.
 */
export type TimerFormat = "auto" | "hh:mm:ss" | "mm:ss" | "ss" | "mm:ss.t";

export const TIMER_FORMATS: TimerFormat[] = ["auto", "hh:mm:ss", "mm:ss", "ss", "mm:ss.t"];

export interface Timer {
	id: string;
	name: string;
	/** Its variable: `{{timer.<key>.text}}`. Unique, `a-z0-9-`. */
	key: string;
	mode: TimerMode;
	/**
	 * `down`: where it starts from. `up`: where it stops; 0 = it never does.
	 */
	durationMs: number;
	/** `down` only: past zero keep counting, with a minus, instead of stopping. */
	overtime: boolean;
	format: TimerFormat;
	running: boolean;
	/** When the current run started, on the server's clock (ms since epoch). */
	startedAt: number | null;
	/**
	 * What was counted before `startedAt`, ms. Below zero on a countdown that
	 * was given more time than it started with.
	 */
	elapsedMs: number;
	/**
	 * The groups of the team it is shared with: their members see it in the
	 * Control panel, and their WebSocket keys may drive it. Empty = everyone.
	 */
	groups: string[];
	createdAt: number;
	updatedAt: number;
}

/** What a page reads from a timer at a given moment. */
export interface TimerVars {
	/** The value in the timer's format: "04:59". */
	text: string;
	/** Hours, minutes within the hour, seconds within the minute: "00", "04", "59". */
	hh: string;
	mm: string;
	ss: string;
	/** Tenths of a second: "3". */
	t: string;
	/** "-" in overtime, "" otherwise. */
	sign: string;
	/** The shown value in whole seconds, negative in overtime. */
	totalSeconds: number;
	/** The exact value, ms, negative in overtime. */
	ms: number;
	/** 0 → 1 over the duration; 0 when there is no duration. */
	progress: number;
	running: boolean;
	/** A countdown reached zero, or a stopwatch its limit. */
	done: boolean;
	/** A countdown is past zero. */
	overtime: boolean;
	name: string;
}

/** Longest duration a timer accepts: 100 hours. */
export const TIMER_MAX_MS = 100 * 3600_000;

export function newTimerDefaults(): Pick<
	Timer,
	"mode" | "durationMs" | "overtime" | "format" | "running" | "startedAt" | "elapsedMs" | "groups"
> {
	return {
		mode: "down",
		durationMs: 5 * 60_000,
		overtime: false,
		format: "auto",
		running: false,
		startedAt: null,
		elapsedMs: 0,
		groups: [],
	};
}

/** What the timer has counted so far, ms. */
export function timerElapsed(timer: Timer, now: number): number {
	const run = timer.running && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0;
	return (timer.elapsedMs ?? 0) + run;
}

/** The elapsed time at which the timer stops by itself, if it does. */
export function timerEnd(timer: Timer): number | undefined {
	if (timer.durationMs <= 0) return undefined;
	if (timer.mode === "down" && timer.overtime) return undefined;
	return timer.durationMs;
}

/** The value the timer shows, ms: what is left of a countdown, or what a stopwatch counted. */
export function timerValue(timer: Timer, now: number): number {
	const end = timerEnd(timer);
	const elapsed = end === undefined ? timerElapsed(timer, now) : Math.min(end, timerElapsed(timer, now));
	return timer.mode === "down" ? timer.durationMs - elapsed : elapsed;
}

/** The elapsed time that makes the timer show `valueMs`. */
export function elapsedForValue(timer: Timer, valueMs: number): number {
	// A stopwatch never shows less than zero; a countdown may be given more
	// time than it started with, which puts its elapsed time below zero.
	if (timer.mode === "up") return Math.max(0, Math.round(valueMs));
	return Math.round(timer.durationMs - Math.max(timer.overtime ? -TIMER_MAX_MS : 0, valueMs));
}

const pad = (value: number, size = 2): string => String(value).padStart(size, "0");

/**
 * The shown value in steps of `stepMs`. A countdown rounds up and a stopwatch
 * down, as clocks do: a countdown reads 00:01 for its last second and turns
 * 00:00 exactly at the end; past zero it rounds away from zero again, so the
 * minus appears once a whole step of overtime has gone by.
 */
function steps(timer: Timer, valueMs: number, stepMs: number): number {
	if (timer.mode === "up") return Math.floor(valueMs / stepMs);
	return valueMs >= 0 ? Math.ceil(valueMs / stepMs) : -Math.floor(-valueMs / stepMs);
}

export function timerVars(timer: Timer, now: number): TimerVars {
	const ms = timerValue(timer, now);
	const tenthsTotal = steps(timer, ms, 100);
	const secondsTotal = timer.format === "mm:ss.t" ? Math.trunc(tenthsTotal / 10) : steps(timer, ms, 1000);
	const negative = timer.format === "mm:ss.t" ? tenthsTotal < 0 : secondsTotal < 0;
	const abs = Math.abs(secondsTotal);
	const hours = Math.floor(abs / 3600);
	const minutes = Math.floor((abs % 3600) / 60);
	const seconds = abs % 60;
	const tenths = Math.abs(tenthsTotal) % 10;
	const sign = negative ? "-" : "";

	let text: string;
	switch (timer.format) {
		case "hh:mm:ss":
			text = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
			break;
		case "mm:ss":
			text = `${pad(Math.floor(abs / 60))}:${pad(seconds)}`;
			break;
		case "ss":
			text = String(abs);
			break;
		case "mm:ss.t":
			text = `${pad(Math.floor(abs / 60))}:${pad(seconds)}.${tenths}`;
			break;
		default:
			text = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
	}

	const elapsed = timerElapsed(timer, now);
	const end = timerEnd(timer);
	return {
		text: `${sign}${text}`,
		hh: pad(hours),
		mm: pad(minutes),
		ss: pad(seconds),
		t: String(tenths),
		sign,
		totalSeconds: negative ? -abs : abs,
		ms,
		progress: timer.durationMs > 0 ? Math.min(1, Math.max(0, elapsed / timer.durationMs)) : 0,
		running: timer.running && (end === undefined || elapsed < end),
		done: end !== undefined ? elapsed >= end : timer.mode === "down" && timer.durationMs > 0 && elapsed >= timer.durationMs,
		overtime: timer.mode === "down" && ms < 0,
		name: timer.name,
	};
}

/** Every timer's variables, by key: the value of `timer` in the variable store. */
export function timersVars(timers: readonly Timer[], now: number): Record<string, TimerVars> {
	const out: Record<string, TimerVars> = {};
	for (const timer of timers) out[timer.key] = timerVars(timer, now);
	return out;
}

/**
 * `data` with the timers in it, under `timer`. A shallow copy: the variable
 * store itself is never written to, so a timer never ends up in a workbook or
 * in the Variables panel. With no timers the data is returned as it is.
 */
export function withTimers<T extends Record<string, unknown>>(data: T, timers: readonly Timer[], now: number): T {
	if (timers.length === 0) return data;
	return { ...data, [TIMER_VAR]: timersVars(timers, now) };
}

/** Every variable a timer offers, for the pickers in the editor. */
export const TIMER_FIELDS: Array<keyof TimerVars> = [
	"text",
	"hh",
	"mm",
	"ss",
	"t",
	"sign",
	"totalSeconds",
	"progress",
	"running",
	"done",
	"overtime",
	"name",
];

export function timerPaths(timers: readonly Timer[]): string[] {
	return timers.flatMap((timer) => TIMER_FIELDS.map((field) => `${TIMER_VAR}.${timer.key}.${field}`));
}

/**
 * Code that reads a timer: `timer("match")`, or a path into one —
 * `timer.match.text` in a `data-bind`, in `vars()` or in `data.timer.match`.
 * The runtime's own `timer` helper does not match it.
 */
const TIMER_USE = /\btimer\s*\(|\btimer\.[\w-]+\.\w+|\[["']timer["']\]/;

export function codeUsesTimers(code: string): boolean {
	return TIMER_USE.test(code);
}

/**
 * Whether a code animation reads a timer, as far as its inline code shows. A
 * code animation that does not is never sent the ticks: its `onData` would
 * otherwise run every second for nothing, and some animations lay out anew
 * there. A file-authored one is checked once its file is loaded.
 */
export function templateUsesTimers(template: TitleTemplate): boolean {
	const code = template.code;
	if (!code) return false;
	return codeUsesTimers(`${code.html ?? ""}\n${code.css ?? ""}\n${code.js ?? ""}`);
}

/** Whether a `layers` animation shows a timer in one of its layers. */
export function layersUseTimers(template: TitleTemplate): boolean {
	return (template.layers ?? []).some((layer) =>
		/\btimer\./.test(`${layer.text ?? ""} ${layer.binding ?? ""} ${layer.src ?? ""}`),
	);
}

/** The variables without the timers in them, for what does not read any. */
export function withoutTimers<T extends Record<string, unknown>>(data: T): T {
	if (!(TIMER_VAR in data)) return data;
	const { [TIMER_VAR]: _timers, ...rest } = data;
	return rest as T;
}

/** How often a page that shows a timer has to look again, ms. */
export function timerTickMs(timers: readonly Timer[]): number {
	return timers.some((timer) => timer.running && timer.format === "mm:ss.t") ? 50 : 200;
}

/** A key for a new timer: from its name, unlike any of `taken`. */
export function uniqueTimerKey(name: string, taken: Iterable<string>, fallback = "timer"): string {
	const used = new Set(taken);
	const base = slugify(name, fallback);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

/** Whoever reaches `groups` (null = every group) sees this timer. */
export function timerWithin(timer: Timer, groups: readonly string[] | null): boolean {
	if (groups === null || timer.groups.length === 0) return true;
	return timer.groups.some((id) => groups.includes(id));
}

/**
 * Reads "90", "1:30", "01:30:00" or "1:30.5" as ms; `undefined` when it is
 * none of these. A bare number is seconds.
 */
export function parseTimerText(input: string): number | undefined {
	const text = input.trim().replace(",", ".");
	if (!text) return undefined;
	const parts = text.split(":");
	if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return undefined;
	let seconds = 0;
	for (const part of parts) seconds = seconds * 60 + Number(part);
	const ms = Math.round(seconds * 1000);
	return Number.isFinite(ms) && ms <= TIMER_MAX_MS ? ms : undefined;
}

/**
 * The server's clock, as seen from a page. Pages ask the extension for its
 * time now and then and keep the difference to their own, so a timer reads the
 * same in OBS on another machine as on the server.
 */
export class ServerClock {
	private offset = 0;
	private bestRtt = Number.POSITIVE_INFINITY;
	private sampledAt = 0;

	now(): number {
		return Date.now() + this.offset;
	}

	/** One round trip: `ask` resolves with the server's `Date.now()`. */
	async sample(ask: () => Promise<number>): Promise<void> {
		const sent = Date.now();
		const server = await ask();
		const received = Date.now();
		const rtt = received - sent;
		if (!Number.isFinite(server) || rtt < 0 || rtt > 5000) return;
		// The fastest answer is the most exact one; an older one is replaced
		// after a while anyway, since clocks drift.
		const stale = received - this.sampledAt > 10 * 60_000;
		if (rtt <= this.bestRtt || stale) {
			this.bestRtt = rtt;
			this.sampledAt = received;
			this.offset = server - (sent + rtt / 2);
		}
	}
}
