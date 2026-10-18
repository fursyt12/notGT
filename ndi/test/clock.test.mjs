import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FrameClock } from "../src/clock.mjs";

/** A clock at 30 fps on mocked time, and what it sent. */
function clock() {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const sent = [];
	const c = new FrameClock({
		fps: 30,
		transmit: (slot) => {
			sent.push([Date.now(), slot]);
			return true;
		},
		now: () => Date.now(),
	});
	return { c, sent };
}

test("nothing goes out while nobody receives", (t) => {
	const { c, sent } = clock();
	t.after(() => mock.timers.reset());
	c.frameReady(0);
	mock.timers.tick(1000);
	assert.deepEqual(sent, []);
});

test("the newest frame goes out the moment someone receives", (t) => {
	const { c, sent } = clock();
	t.after(() => mock.timers.reset());
	c.frameReady(0);
	c.frameReady(1);
	c.setWatching(true);
	assert.deepEqual(sent, [[1000, 1]]);
});

test("a still picture goes out again at the out's rate", (t) => {
	const { c, sent } = clock();
	t.after(() => mock.timers.reset());
	c.setWatching(true);
	c.frameReady(0);
	// Time passes in small steps: a mocked tick runs only timers set before it.
	for (let i = 0; i < 100; i++) mock.timers.tick(10);
	// 1 + 29 repeats in a second, all of slot 0.
	assert.ok(sent.length >= 29 && sent.length <= 31, `${sent.length} frames`);
	assert.ok(sent.every(([, slot]) => slot === 0));
});

test("no more frames go out than the rate, however fast they come", (t) => {
	const { c, sent } = clock();
	t.after(() => mock.timers.reset());
	c.setWatching(true);
	// A frame every 8 ms (125 fps) for a second.
	for (let i = 0; i < 125; i++) {
		c.frameReady(c.freeSlot());
		mock.timers.tick(8);
	}
	assert.ok(sent.length >= 29 && sent.length <= 31, `${sent.length} frames`);
	for (let i = 1; i < sent.length; i++)
		assert.ok(sent[i][0] - sent[i - 1][0] >= 24, `frames ${i - 1} and ${i} too close`);
});

test("the slot NDI reads and the one waiting are never written into", (t) => {
	const { c } = clock();
	t.after(() => mock.timers.reset());
	c.setWatching(true);
	c.frameReady(0); // goes out: NDI reads 0
	const next = c.freeSlot();
	assert.notEqual(next, 0);
	c.frameReady(next); // early: waits
	const third = c.freeSlot();
	assert.ok(third !== 0 && third !== next);
});

test("after a new size, nothing old goes out", (t) => {
	const { c, sent } = clock();
	t.after(() => mock.timers.reset());
	c.frameReady(0);
	c.reset();
	c.setWatching(true);
	assert.deepEqual(sent, []);
});

test("a slot with nothing to send is not counted", (t) => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	t.after(() => mock.timers.reset());
	const c = new FrameClock({ fps: 30, transmit: () => false, now: () => Date.now() });
	c.setWatching(true);
	c.frameReady(0);
	assert.equal(c.sent, 0);
	assert.equal(c.sentSlot, null);
});

// ------------------------------------------------- against Chromium's clock
/** Time in fractional milliseconds, and timers on it. */
function scheduler() {
	let t = 0;
	let id = 0;
	const queue = [];
	return {
		now: () => t,
		timers: {
			set: (fn, ms) => {
				const entry = { at: t + ms, fn, id: ++id, dead: false };
				queue.push(entry);
				return entry;
			},
			clear: (entry) => {
				if (entry) entry.dead = true;
			},
		},
		/** Runs every timer due by `until`, in order, then stands at `until`. */
		run(until, late = 0) {
			for (;;) {
				let next;
				for (const e of queue)
					if (!e.dead && e.at + late <= until && (!next || e.at < next.at || (e.at === next.at && e.id < next.id)))
						next = e;
				if (!next) break;
				next.dead = true;
				t = next.at + late;
				next.fn();
			}
			for (let i = queue.length - 1; i >= 0; i--) if (queue[i].dead) queue.splice(i, 1);
			t = until;
		},
	};
}

/** The clock as it was: a grid of its own, paints only told it what was early. */
class LegacyClock extends FrameClock {
	frameReady(slot) {
		if (this.stopped) return;
		this.readySlot = slot;
		this.latestSlot = slot;
		if (!this.watching) return;
		if (this.due - this.now() <= 0.25 * this.frameMs) this.sendReady(false);
		else if (!(this.timerDue <= this.due)) this.at(this.due);
	}
	send(slot) {
		if (!this.transmit(slot)) return;
		this.sentSlot = slot;
		const now = this.now();
		this.due = (now - this.due > this.frameMs ? now : this.due) + this.frameMs;
		this.sent++;
	}
}

/**
 * Chromium painting every `paintMs` for `seconds`, each frame ready
 * `convertMs` (± `jitterMs`) later, against an out at `fps`.
 */
function play({ Clock = FrameClock, fps = 60, paintMs = 16.666, seconds = 60, convertMs = 1, jitterMs = 0, late = 0, still = false }) {
	const s = scheduler();
	const ready = new Map();
	const sends = [];
	const waits = [];
	let fresh = 0;
	const c = new Clock({
		fps,
		now: s.now,
		timers: s.timers,
		transmit: (slot) => {
			sends.push(s.now());
			const at = ready.get(slot);
			if (at !== undefined) {
				waits.push(s.now() - at);
				ready.delete(slot);
			}
			return true;
		},
	});
	c.setWatching(true);
	let seed = 1;
	const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
	const frames = Math.floor((seconds * 1000) / paintMs);
	for (let k = 0; k < (still ? 1 : frames); k++) {
		const at = 100 + k * paintMs + convertMs + jitterMs * random();
		s.run(at, late);
		const slot = c.freeSlot();
		ready.set(slot, at);
		fresh++;
		c.frameReady(slot);
	}
	// Moving: stop with the last paint (after it, repeats are right).
	s.run(still ? 100 + seconds * 1000 : 100 + frames * paintMs + convertMs + 2, late);
	const span = (sends.at(-1) - sends[0]) / 1000;
	const sorted = [...waits].sort((a, b) => a - b);
	const intervals = sends.slice(1).map((t, i) => t - sends[i]);
	return {
		rate: (sends.length - 1) / span,
		sent: sends.length,
		dropped: fresh - waits.length,
		repeats: sends.length - waits.length,
		waitP50: sorted[Math.floor(sorted.length / 2)],
		waitMax: sorted.at(-1),
		minInterval: Math.min(...intervals),
	};
}

test("the old clock drifts against Chromium's: waits up to a frame, then drops one", () => {
	const r = play({ Clock: LegacyClock, seconds: 480 });
	assert.ok(r.waitMax > 15, `waits up to ${r.waitMax.toFixed(2)} ms`);
	assert.ok(r.dropped >= 1, `${r.dropped} dropped`);
});

test("the clock follows Chromium's: every frame goes out as it is painted, none dropped", () => {
	const r = play({ seconds: 480 });
	assert.equal(r.dropped, 0);
	assert.ok(r.waitMax < 0.01, `waits up to ${r.waitMax} ms`);
	assert.equal(r.repeats, 0, "no repeats while it moves");
});

test("…with the jitter of a real conversion as well", () => {
	const r = play({ seconds: 480, jitterMs: 1.5 });
	assert.equal(r.dropped, 0);
	assert.ok(r.waitMax < 0.01, `waits up to ${r.waitMax} ms`);
	assert.ok(Math.abs(r.rate - 60) < 0.01, `${r.rate} fps`);
});

test("…and when Chromium's clock is the slower one", () => {
	const r = play({ seconds: 480, paintMs: 1000 / 60 + 0.0007 });
	assert.equal(r.dropped, 0);
	assert.equal(r.repeats, 0, "no frame sent twice while it moves");
	assert.ok(r.waitMax < 0.01, `waits up to ${r.waitMax} ms`);
});

test("painting faster than the out still sends no more than the out's rate", () => {
	for (const [fps, paintMs] of [[30, 16.666], [50, 16.666], [25, 20], [29.97, 16.666]]) {
		const r = play({ fps, paintMs, seconds: 120, jitterMs: 1 });
		assert.ok(r.rate <= fps * 1.005 + 0.01, `${fps} fps out, painted every ${paintMs} ms: ${r.rate.toFixed(3)} fps`);
		assert.ok(r.rate >= fps * 0.99, `${fps} fps out: only ${r.rate.toFixed(3)} fps`);
		assert.ok(r.minInterval >= (0.75 * 1000) / fps - 1.5, `${fps} fps out: frames ${r.minInterval.toFixed(2)} ms apart`);
	}
});

test("a still picture goes out at exactly the out's rate, however late the timers", () => {
	const r = play({ still: true, seconds: 600, late: 1.3 });
	assert.ok(Math.abs(r.rate - 60) < 0.01, `${r.rate} fps`);
});
