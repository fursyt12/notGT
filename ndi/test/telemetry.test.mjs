import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameClock } from "../src/clock.mjs";
import { Tally, describeWindow, percentiles } from "../src/telemetry.mjs";

/** Chromium painting every `paintMs` for `seconds` into a clock at `fps`, on time of its own. */
function play({ fps, paintMs, seconds, still = false }) {
	let t = 0;
	const queue = [];
	const timers = {
		set: (fn, ms) => {
			const entry = { at: t + ms, fn, dead: false };
			queue.push(entry);
			return entry;
		},
		clear: (entry) => {
			if (entry) entry.dead = true;
		},
	};
	const run = (until) => {
		for (;;) {
			let next;
			for (const e of queue) if (!e.dead && e.at <= until && (!next || e.at < next.at)) next = e;
			if (!next) break;
			next.dead = true;
			t = next.at;
			next.fn();
		}
		t = until;
	};
	const tally = new Tally();
	const clock = new FrameClock({ fps, now: () => t, timers, transmit: () => true, tally });
	clock.setWatching(true);
	const frames = still ? 1 : Math.floor((seconds * 1000) / paintMs);
	for (let k = 0; k < frames; k++) {
		run(100 + k * paintMs + 1);
		clock.frameReady(clock.freeSlot());
	}
	run(100 + (still ? seconds * 1000 : frames * paintMs + 3));
	return tally;
}

test("the clock counts what goes out new, again, and not at all", () => {
	// Painted at 60 for an out at 30: every other frame is dropped.
	const fast = play({ fps: 30, paintMs: 1000 / 60, seconds: 10 }).counts;
	assert.ok(Math.abs(fast.fresh - 300) <= 2, `${fast.fresh} new`);
	assert.ok(Math.abs(fast.dropped - 300) <= 2, `${fast.dropped} dropped`);
	assert.equal(fast.repeats, 0);
	// A still picture: one new, then the same again at the out's rate.
	const still = play({ fps: 30, paintMs: 1000 / 30, seconds: 10, still: true }).counts;
	assert.equal(still.fresh, 1);
	assert.ok(Math.abs(still.repeats - 300) <= 2, `${still.repeats} again`);
	assert.equal(still.dropped, 0);
});

test("the gaps between frames sent are timed", () => {
	const { times } = play({ fps: 60, paintMs: 1000 / 60, seconds: 10 }).window();
	assert.ok(Math.abs(times.send.p50 - 16.7) < 0.2, `p50 ${times.send.p50} ms`);
	assert.ok(times.send.max < 17, `max ${times.send.max} ms`);
});

test(
	"at 59.94 the clock sends 59.94 frames a second, not Chromium's 60",
	{ todo: "the clock follows Chromium's 60 and sends 0.1 % more frames than it declares" },
	() => {
		const tally = play({ fps: 59.94, paintMs: 1000 / 60, seconds: 600 });
		const sent = tally.counts.fresh + tally.counts.repeats;
		const due = (600 * 60000) / 1001;
		assert.ok(Math.abs(sent - due) <= 1, `${sent} frames in 10 minutes, ${due.toFixed(0)} due`);
	},
);

test("a window holds what was counted and timed in it, then the next one starts", () => {
	const tally = new Tally();
	tally.painted(0);
	tally.painted(16);
	tally.painted(50);
	tally.took();
	tally.took();
	tally.gaveBack(0, 10);
	tally.count("replaced");
	const first = tally.window();
	assert.equal(first.counts.painted, 3);
	assert.equal(first.counts.replaced, 1);
	assert.equal(first.times.paint.n, 2);
	assert.equal(first.times.paint.max, 34);
	assert.equal(first.times.hold.max, 10);
	assert.equal(first.mostHeld, 2);
	const second = tally.window();
	assert.equal(second.counts.painted, 0);
	assert.equal(second.times.paint, undefined);
	assert.equal(second.mostHeld, 1, "one texture is still kept");
	assert.equal(tally.counts.painted, 3, "the counts run from the start");
});

test("what one tally drains, another absorbs, once", () => {
	const page = new Tally();
	const main = new Tally();
	page.count("fresh", 5);
	page.time("send", 16.7);
	main.absorb(page.drain());
	page.count("fresh", 2);
	main.absorb(page.drain());
	main.absorb(page.drain());
	assert.equal(main.counts.fresh, 7);
	assert.equal(main.window().times.send.n, 1);
});

test("the debug line says where the frames went", () => {
	const tally = new Tally();
	tally.painted(0);
	tally.count("replaced", 2);
	tally.count("dropped");
	const line = describeWindow(tally.window());
	assert.match(line, /^1 painted, 2 replaced waiting, 0 converted, 0 sent new and 0 again, 1 dropped by the clock/);
});

test("percentiles of nothing are nothing", () => {
	assert.deepEqual(percentiles([]), { p50: null, p95: null, p99: null, max: null, n: 0 });
	assert.deepEqual(percentiles([5, 1, 3]), { p50: 3, p95: 5, p99: 5, max: 5, n: 3 });
});
