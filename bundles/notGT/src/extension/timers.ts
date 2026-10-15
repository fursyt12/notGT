import { clone } from "../shared/binding";
import {
	TIMER_FORMATS,
	TIMER_MAX_MS,
	type Timer,
	type TimerFormat,
	type TimerVars,
	elapsedForValue,
	newTimerDefaults,
	parseTimerText,
	timerElapsed,
	timerEnd,
	timerValue,
	timerVars,
	timerWithin,
	uniqueTimerKey,
} from "../shared/timer";
import { BUNDLE_NAME, MESSAGES, newId, REPLICANTS, slugify } from "../shared/types";
import type { ServerAPI } from "./store";

/**
 * The timers, as kept by the extension.
 *
 * Every change goes through `command`, on the server's clock: a dashboard
 * panel, the REST API and the WebSocket all ask here instead of writing the
 * Replicant themselves, so a "start" pressed in a browser whose clock is off
 * by a minute still starts the timer now.
 *
 * A timer that stops by itself — a countdown at zero, a stopwatch at its
 * limit — is also stopped here, at that moment, so `running` in the state an
 * integration reads is the truth and not just what the pages work out.
 */

export const TIMER_COMMANDS = [
	"create",
	"update",
	"remove",
	"start",
	"pause",
	"toggle",
	"reset",
	"restart",
	"set",
	"adjust",
] as const;
export type TimerCommand = (typeof TIMER_COMMANDS)[number];

/** A request the timers refuse, with a code the APIs turn into a status. */
export class TimerError extends Error {
	constructor(
		readonly code: "bad_request" | "not_found" | "forbidden",
		message: string,
	) {
		super(message);
	}
}

export const timerErrorStatus = (error: TimerError): number =>
	error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 400;

export interface TimerResult {
	timer?: Timer;
	removed?: string;
}

/** A timer and what it shows right now, as the APIs hand it out. */
export type TimerReading = Timer & { vars: TimerVars; serverTime: number };

export interface Timers {
	list(): Timer[];
	/** By id or by key. */
	find(ref: string): Timer | undefined;
	read(timer: Timer, now?: number): TimerReading;
	/**
	 * Runs a command. `reach` is the groups whoever asks may work with (null =
	 * all): a timer outside them is refused, and a timer they create is shared
	 * with them.
	 */
	command(name: string, params: Record<string, unknown>, reach?: string[] | null): TimerResult;
	onChange(listener: () => void): void;
	dispose(): void;
}

const isCommand = (name: string): name is TimerCommand => (TIMER_COMMANDS as readonly string[]).includes(name);

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A duration in ms from `<name>Ms` (a number) or `<name>` ("1:30", or seconds). */
function duration(params: Record<string, unknown>, name: string): number | undefined {
	const ms = params[`${name}Ms`];
	if (typeof ms === "number" && Number.isFinite(ms)) return ms;
	const raw = params[name];
	if (typeof raw === "number" && Number.isFinite(raw)) return raw * 1000;
	if (typeof raw === "string") {
		const parsed = parseTimerText(raw.replace(/^[-+]/, ""));
		if (parsed === undefined) throw new TimerError("bad_request", `\`${name}\` is not a time: ${raw}`);
		return raw.trim().startsWith("-") ? -parsed : parsed;
	}
	return undefined;
}

const clampMs = (ms: number): number => Math.max(0, Math.min(TIMER_MAX_MS, Math.round(ms)));

/** A stored timer brought back to the current shape, whatever an older version left. */
function normalize(raw: Partial<Timer>, index: number): Timer {
	const defaults = newTimerDefaults();
	const now = Date.now();
	return {
		...defaults,
		...raw,
		id: typeof raw.id === "string" && raw.id ? raw.id : newId("timer"),
		name: typeof raw.name === "string" && raw.name ? raw.name : `Timer ${index + 1}`,
		key: typeof raw.key === "string" && raw.key ? raw.key : `timer-${index + 1}`,
		mode: raw.mode === "up" ? "up" : "down",
		format: TIMER_FORMATS.includes(raw.format as TimerFormat) ? (raw.format as TimerFormat) : "auto",
		groups: Array.isArray(raw.groups) ? raw.groups.filter((id): id is string => typeof id === "string") : [],
		running: raw.running === true && typeof raw.startedAt === "number",
		startedAt: raw.running === true && typeof raw.startedAt === "number" ? raw.startedAt : null,
		elapsedMs: typeof raw.elapsedMs === "number" && Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : 0,
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
	};
}

/** The timer, stopped where it is: what it counted is folded into `elapsedMs`. */
function folded(timer: Timer, now: number): Timer {
	const end = timerEnd(timer);
	const elapsed = timerElapsed(timer, now);
	return { ...timer, running: false, startedAt: null, elapsedMs: end === undefined ? elapsed : Math.min(end, elapsed) };
}

/** Restarts the clock of a running timer from now, so its elapsed time can be edited. */
function rebased(timer: Timer, now: number): Timer {
	if (!timer.running) return timer;
	return { ...folded(timer, now), running: true, startedAt: now };
}

export function createTimers(
	nodecg: ServerAPI,
	opts: {
		hasGroup?: (id: string) => boolean;
		/** Timers to make when no timer has their key (the examples' own). */
		seed?: ReadonlyArray<{ key: string }>;
	} = {},
): Timers {
	const log = nodecg.log;
	const replicant = nodecg.Replicant<Timer[]>(REPLICANTS.timers, BUNDLE_NAME, {
		defaultValue: [],
		persistent: true,
	});
	const listeners = new Set<() => void>();
	let settle: ReturnType<typeof setTimeout> | undefined;

	const list = (): Timer[] => (replicant.value ?? []) as Timer[];
	const find = (ref: string): Timer | undefined => list().find((timer) => timer.id === ref || timer.key === ref);

	const write = (next: Timer[]): void => {
		replicant.value = clone(next);
		scheduleSettle();
		for (const listener of listeners) listener();
	};

	/**
	 * Stops the timers that have reached their end, then waits for the next
	 * one to. One timeout for all of them, re-armed on every change.
	 */
	function scheduleSettle(): void {
		if (settle) clearTimeout(settle);
		settle = undefined;
		const now = Date.now();
		let next = Number.POSITIVE_INFINITY;
		let due = false;
		for (const timer of list()) {
			const end = timerEnd(timer);
			if (!timer.running || end === undefined) continue;
			const left = end - timerElapsed(timer, now);
			if (left <= 0) due = true;
			else next = Math.min(next, left);
		}
		if (due) {
			write(list().map((timer) => (timer.running && timerEnd(timer) !== undefined && timerElapsed(timer, now) >= timerEnd(timer)! ? folded(timer, now) : timer)));
			return;
		}
		if (Number.isFinite(next)) {
			// Never more than a minute at a time: a long timeout drifts, and a
			// clock that jumps is caught at the next look.
			settle = setTimeout(scheduleSettle, Math.min(60_000, next + 5));
			settle.unref?.();
		}
	}

	const groupsOf = (value: unknown): string[] => {
		if (!Array.isArray(value)) throw new TimerError("bad_request", "`groups` must be a list of group ids");
		const ids = [...new Set(value.filter((id): id is string => typeof id === "string"))];
		return opts.hasGroup ? ids.filter((id) => opts.hasGroup!(id)) : ids;
	};

	/** The settings a `create` or an `update` may carry, checked. */
	function settings(params: Record<string, unknown>, base: Timer, taken: string[]): Timer {
		const next = { ...base };
		const name = text(params["name"]);
		if (name !== undefined) next.name = name.slice(0, 64);
		if (params["key"] !== undefined) {
			const key = slugify(String(params["key"]), "");
			if (!key) throw new TimerError("bad_request", "`key` needs letters or digits");
			if (taken.includes(key)) throw new TimerError("bad_request", `Another timer already has the key "${key}"`);
			next.key = key;
		}
		if (params["mode"] !== undefined) {
			if (params["mode"] !== "down" && params["mode"] !== "up") {
				throw new TimerError("bad_request", "`mode` is `down` (a countdown) or `up` (a stopwatch)");
			}
			next.mode = params["mode"];
		}
		const ms = duration(params, "duration");
		if (ms !== undefined) next.durationMs = clampMs(ms);
		if (params["overtime"] !== undefined) next.overtime = params["overtime"] === true;
		if (params["format"] !== undefined) {
			if (!TIMER_FORMATS.includes(params["format"] as TimerFormat)) {
				throw new TimerError("bad_request", `\`format\` is one of: ${TIMER_FORMATS.join(", ")}`);
			}
			next.format = params["format"] as TimerFormat;
		}
		if (params["groups"] !== undefined) next.groups = groupsOf(params["groups"]);
		return next;
	}

	function command(name: string, params: Record<string, unknown>, reach: string[] | null = null): TimerResult {
		if (!isCommand(name)) {
			throw new TimerError("bad_request", `Unknown timer command: ${name}. One of: ${TIMER_COMMANDS.join(", ")}`);
		}
		const now = Date.now();
		const timers = list();

		if (name === "create") {
			const base: Timer = {
				...newTimerDefaults(),
				id: newId("timer"),
				name: `Timer ${timers.length + 1}`,
				key: "",
				// Whoever reaches only some groups shares what they make with them.
				groups: reach ?? [],
				createdAt: now,
				updatedAt: now,
			};
			const taken = timers.map((timer) => timer.key);
			// A stopwatch made without a limit has none: the five minutes are a
			// countdown's default.
			if (params["mode"] === "up" && params["duration"] === undefined && params["durationMs"] === undefined) {
				base.durationMs = 0;
			}
			const timer = settings(params, base, taken);
			if (!timer.key) timer.key = uniqueTimerKey(timer.name, taken);
			if (reach !== null && !timerWithin(timer, reach)) timer.groups = [...new Set([...timer.groups, ...reach])];
			write([...timers, timer]);
			return { timer };
		}

		const ref = text(params["timer"]) ?? text(params["id"]) ?? text(params["key"]);
		if (!ref) throw new TimerError("bad_request", "Name the `timer`: its id or its key");
		const current = find(ref);
		if (!current) throw new TimerError("not_found", `Unknown timer: ${ref}`);
		if (!timerWithin(current, reach)) throw new TimerError("forbidden", `The timer "${current.key}" is not shared with you`);

		if (name === "remove") {
			write(timers.filter((timer) => timer.id !== current.id));
			return { removed: current.id };
		}

		let next: Timer;
		switch (name) {
			case "update": {
				const taken = timers.filter((timer) => timer.id !== current.id).map((timer) => timer.key);
				// A running timer keeps going from where it is: rebase first, so a
				// new mode or duration applies to what was counted so far.
				const { key: _key, ...rest } = params;
				next = settings(params["key"] === current.key ? rest : params, rebased(current, now), taken);
				if (reach !== null && !timerWithin(next, reach)) {
					throw new TimerError("forbidden", "Keep the timer shared with one of your own groups");
				}
				if (next.running && timerEnd(next) !== undefined && timerElapsed(next, now) >= timerEnd(next)!) {
					next = folded(next, now);
				}
				break;
			}
			case "start":
			case "toggle":
			case "pause": {
				const stop = name === "pause" || (name === "toggle" && current.running);
				if (stop) {
					next = current.running ? folded(current, now) : current;
				} else if (current.running) {
					next = current;
				} else {
					// Starting a timer that has run out starts it over.
					const end = timerEnd(current);
					const over = end !== undefined && current.elapsedMs >= end;
					next = { ...current, running: true, startedAt: now, elapsedMs: over ? 0 : current.elapsedMs };
				}
				break;
			}
			case "reset":
				next = { ...current, running: false, startedAt: null, elapsedMs: 0 };
				break;
			case "restart":
				next = { ...current, running: true, startedAt: now, elapsedMs: 0 };
				break;
			case "set": {
				const value = duration(params, "value");
				if (value === undefined) throw new TimerError("bad_request", "Missing `value` (\"1:30\", or seconds) or `valueMs`");
				const base = rebased(current, now);
				next = { ...base, elapsedMs: elapsedForValue(base, value) };
				break;
			}
			case "adjust": {
				const delta = duration(params, "delta");
				if (delta === undefined) throw new TimerError("bad_request", "Missing `delta` (seconds, \"+1:00\", \"-10\") or `deltaMs`");
				// Adding a minute adds it to what the timer *shows*: more time left
				// on a countdown, more counted on a stopwatch.
				const base = current.running ? rebased(current, now) : current;
				const shown = timerValue(base, now);
				next = { ...base, elapsedMs: elapsedForValue(base, shown + delta) };
				break;
			}
			default:
				throw new TimerError("bad_request", `Unknown timer command: ${name}`);
		}
		next = { ...next, updatedAt: now };
		write(timers.map((timer) => (timer.id === current.id ? next : timer)));
		return { timer: next };
	}

	// Older or hand-edited values are brought into shape once at boot.
	{
		const raw = (replicant.value ?? []) as unknown[];
		const fixed = Array.isArray(raw)
			? raw.filter((entry) => entry && typeof entry === "object").map((entry, index) => normalize(entry as Partial<Timer>, index))
			: [];
		if (JSON.stringify(fixed) !== JSON.stringify(raw)) replicant.value = fixed;
		for (const sample of opts.seed ?? []) {
			if (!find(sample.key)) command("create", { ...sample });
		}
		scheduleSettle();
		const running = fixed.filter((timer) => timer.running).length;
		if (fixed.length > 0) log.info("Timers: %d (%d running)", fixed.length, running);
	}

	// The dashboard drives the timers through a message, so the server's clock
	// is the one that counts.
	nodecg.listenFor(MESSAGES.timer, ((data: unknown, ack: any) => {
		const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
		const { command: name, ...params } = payload;
		try {
			const result = command(typeof name === "string" ? name : "", params);
			if (ack && !ack.handled) ack(null, result);
		} catch (error) {
			if (!(error instanceof TimerError)) log.error("Timer command failed:", error);
			if (ack && !ack.handled) ack(error instanceof TimerError ? error.message : "The timer command failed");
		}
	}) as any);
	nodecg.listenFor(MESSAGES.clock, ((_data: unknown, ack: any) => {
		if (ack && !ack.handled) ack(null, Date.now());
	}) as any);

	return {
		list,
		find,
		read(timer, now = Date.now()) {
			return { ...timer, vars: timerVars(timer, now), serverTime: now };
		},
		command,
		onChange(listener) {
			listeners.add(listener);
		},
		dispose() {
			if (settle) clearTimeout(settle);
			settle = undefined;
		},
	};
}
