/**
 * What becomes of an out's frames, counted at each place one can be lost
 * between the page and the receiver: the numbers behind the debug line
 * (NOTGT_NDI_DEBUG=1), the out's status (`pipeline`) and scripts/bench.mjs.
 *
 *   page ─ paint ─► converter ─► clock ─► NDI · Spout
 *            │          │          ├ fresh     a new frame sent
 *            │          │          ├ repeats   the last one again: nothing new came
 *            │          │          └ dropped   ready, but a newer one came before its turn
 *            │          ├ converted
 *            │          └ skipped    Spout: a receiver held the texture, not written
 *            └ replaced   waited for a busy converter, and a newer paint took its place
 *
 * The counts run from the out's start. The times, in ms, are kept for a
 * window — until they are next read: between paints, a paint waiting for
 * the converter, a texture kept from Chromium (paint to release), a
 * conversion, and between frames sent.
 *
 * NOTGT_NDI_TRACE=1 also logs every event of every frame, as it happens: a
 * time (ms of the wall clock, to the hundredth, the same in every process),
 * then what happened — painted, replaced, converted, ready (in the clock),
 * fresh, repeats, dropped, skipped.
 */

/** Times kept per window at most: a minute at 60 fps, and more. */
const KEEP = 4096;
const COUNTS = ["painted", "replaced", "converted", "skipped", "fresh", "repeats", "dropped"];
const TIMES = ["paint", "wait", "hold", "convert", "send"];

const zeros = () => Object.fromEntries(COUNTS.map((what) => [what, 0]));
const lists = () => Object.fromEntries(TIMES.map((what) => [what, []]));

export class Tally {
	/** @param {{ trace?: (line: string) => void }} [options] where NOTGT_NDI_TRACE's lines go */
	constructor({ trace } = {}) {
		this.trace = trace;
		this.counts = zeros();
		this.times = lists();
		/** Textures kept from Chromium right now, and the most at once this window. */
		this.held = 0;
		this.mostHeld = 0;
		this.lastPaint = undefined;
		/** The counts when the last window was read, and when last drained. */
		this.windowed = zeros();
		this.drained = zeros();
	}

	count(what, n = 1, details = "") {
		this.counts[what] += n;
		this.note(what, details);
	}

	/** Traced: a line saying what just happened. */
	note(event, details = "") {
		if (!this.trace) return;
		const at = (performance.timeOrigin + performance.now()) % 1e6;
		this.trace(`${at.toFixed(2)} ${event}${details ? ` ${details}` : ""}`);
	}

	time(what, ms) {
		const list = this.times[what];
		if (list.length < KEEP) list.push(ms);
	}

	/** Chromium painted a frame at `now`. */
	painted(now) {
		this.counts.painted++;
		if (this.lastPaint !== undefined) this.time("paint", now - this.lastPaint);
		this.lastPaint = now;
		this.note("painted");
	}

	/** One of Chromium's textures is kept… */
	took() {
		this.held++;
		if (this.held > this.mostHeld) this.mostHeld = this.held;
	}

	/** …and given back; it was painted at `paintedAt`. */
	gaveBack(paintedAt, now = performance.now()) {
		this.held = Math.max(0, this.held - 1);
		this.time("hold", now - paintedAt);
	}

	/**
	 * The window since this was last asked: what was counted in it, the
	 * times as percentiles, the most textures kept at once. The next one
	 * starts.
	 */
	window() {
		const counts = {};
		for (const what of COUNTS) {
			counts[what] = this.counts[what] - this.windowed[what];
			this.windowed[what] = this.counts[what];
		}
		const times = {};
		for (const what of TIMES) {
			if (this.times[what].length) times[what] = percentiles(this.times[what]);
			this.times[what] = [];
		}
		const mostHeld = this.mostHeld;
		this.mostHeld = this.held;
		return { counts, times, mostHeld };
	}

	/**
	 * What was counted and timed since this was last drained, for a tally in
	 * another process to absorb (the WebGL converter's page, see gpu/sink.mjs).
	 */
	drain() {
		const counts = {};
		for (const what of COUNTS) {
			counts[what] = this.counts[what] - this.drained[what];
			this.drained[what] = this.counts[what];
		}
		const times = this.times;
		this.times = lists();
		return { counts, times };
	}

	/** Adds what another tally drained. */
	absorb({ counts = {}, times = {} } = {}) {
		for (const what of COUNTS) this.counts[what] += counts[what] ?? 0;
		for (const what of TIMES) for (const ms of times[what] ?? []) this.time(what, ms);
	}
}

/** A window as the debug line says it. */
export function describeWindow({ counts: c, times: t, mostHeld }) {
	const spread = (what, label) => {
		const p = t[what];
		return p ? `${label} p50 ${p.p50} / p99 ${p.p99} / max ${p.max} ms` : "";
	};
	return [
		`${c.painted} painted, ${c.replaced} replaced waiting, ${c.converted} converted${c.skipped ? `, ${c.skipped} skipped` : ""}, ${c.fresh} sent new and ${c.repeats} again, ${c.dropped} dropped by the clock`,
		spread("paint", "between paints"),
		spread("hold", "textures kept"),
		spread("send", "between frames sent"),
		mostHeld ? `${mostHeld} texture(s) kept at once at most` : "",
	]
		.filter(Boolean)
		.join("; ");
}

/** p50, p95, p99, the most and how many, to a tenth of a ms. */
export function percentiles(values) {
	if (!values.length) return { p50: null, p95: null, p99: null, max: null, n: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
	return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1)), n: sorted.length };
}

function round(value) {
	return Math.round(value * 10) / 10;
}
