/**
 * An out's frame clock: when a frame goes to NDI. Every sink keeps one (the
 * native and WebGL ones with three slots — one NDI reads, one waiting, one
 * being written — the CPU one with a single picture):
 *  - no more frames go out than the out's rate: a frame that is ready a
 *    quarter of a frame early or more waits for its turn, and a newer one
 *    replaces it meanwhile;
 *  - while nothing new is ready, the last frame goes out again at the out's
 *    rate — receivers stutter on a source that sends less often;
 *  - the clock follows Chromium's: a frame sent the moment it was painted
 *    pulls the clock towards that moment, by at most `LOCK` of a frame;
 *  - repeats keep the clock as it is — timers run late, and late must not
 *    mean slower.
 * Nothing goes out while nobody receives the source. What goes out new,
 * what goes out again and what is dropped is counted in the out's tally
 * (telemetry.mjs).
 *
 * Why it follows: Chromium paints on a clock of its own, whose 60 fps is
 * every 16 666 µs (16.6667 ms cut to whole microseconds; measured over
 * 10 680 paints). A clock that kept to 1000/60 ms slips 0.66 µs a frame
 * against it: each frame waited a little longer for its turn, up to a whole
 * frame after seven minutes, when one was dropped and the wait began again —
 * latency going round from 26 to 41 ms at 60 fps.
 */

import { Tally } from "./telemetry.mjs";

/** How far a frame may move the clock, as a share of a frame. */
export const LOCK = 0.005;

/**
 * When the frame after one sent at `now` is due.
 * @param {object} o
 * @param {number} o.due when this one was due
 * @param {number} o.now when it went out
 * @param {number} o.frameMs
 * @param {boolean} o.follow it went out the moment it was painted: its time
 *   says where Chromium's clock is
 */
export function nextDue({ due, now, frameMs, follow }) {
	const late = now - due;
	// Far behind — after a pause, or a stall — the count starts again.
	if (!(late <= frameMs)) return now + frameMs;
	if (!follow) return due + frameMs;
	const lock = LOCK * frameMs;
	return due + frameMs + Math.max(-lock, Math.min(lock, late));
}

export class FrameClock {
	/**
	 * @param {object} options
	 * @param {number} options.fps
	 * @param {(slot: number) => boolean} options.transmit hands NDI a slot;
	 *   false when there was nothing in it to send
	 * @param {() => number} [options.now] milliseconds; tests bring their own
	 * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [options.timers]
	 * @param {Tally} [options.tally] counts what goes out, again or not at all
	 */
	constructor({
		fps,
		transmit,
		now = () => performance.now(),
		// Called as functions, not as methods of this object: a page's
		// setTimeout throws "Illegal invocation" when its `this` is not the page.
		timers = {
			set: (fn, ms) => setTimeout(fn, ms),
			clear: (timer) => clearTimeout(timer),
		},
		tally = new Tally(),
	}) {
		this.frameMs = 1000 / fps;
		this.transmit = transmit;
		this.tally = tally;
		/** When the last frame went out while watched: the gaps are timed. */
		this.lastSentAt = undefined;
		this.now = now;
		this.timers = timers;
		this.watching = false;
		/** The slot NDI reads, the one waiting to go out, the newest of all. */
		this.sentSlot = null;
		this.readySlot = null;
		this.latestSlot = null;
		this.due = -Infinity;
		this.sentAt = -Infinity;
		/** When the last new frame was ready: motion, or a still picture. */
		this.freshAt = -Infinity;
		/** The next frame sets the clock (motion starts after a still picture). */
		this.anchor = false;
		this.timer = undefined;
		this.timerDue = undefined;
		this.sent = 0;
		this.stopped = false;
	}

	/** A slot neither NDI nor the clock holds: the one to write into. */
	freeSlot() {
		return [0, 1, 2].find((i) => i !== this.sentSlot && i !== this.readySlot);
	}

	/** The slots' memory is new (another size): nothing in them counts. */
	reset() {
		this.sentSlot = null;
		this.readySlot = null;
		this.latestSlot = null;
	}

	/** A new frame is in `slot`. */
	frameReady(slot) {
		if (this.stopped) return;
		// Watched, a frame still waiting for its turn is one no receiver gets.
		if (this.watching && this.readySlot !== null) this.tally.count("dropped", 1, `slot ${this.readySlot}`);
		this.readySlot = slot;
		this.latestSlot = slot;
		const now = this.now();
		const moving = now - this.freshAt <= 2 * this.frameMs;
		this.freshAt = now;
		if (!this.watching) return;
		if (!moving) {
			// Motion starts: its first frame sets the clock — at once, unless
			// a repeat has only just gone out.
			this.due = Math.max(now, this.sentAt + 0.25 * this.frameMs);
			this.anchor = true;
		}
		this.tally.note("ready", `slot ${slot}, due in ${(this.due - now).toFixed(1)} ms${moving ? "" : ", motion starts"}`);
		if (this.due - now <= 0.25 * this.frameMs) this.sendReady(true);
		else if (!(this.timerDue <= this.due)) this.at(this.due);
	}

	setWatching(watching) {
		if (watching === this.watching) return;
		this.watching = watching;
		if (!watching) {
			this.cancel();
			this.lastSentAt = undefined;
			return;
		}
		// The newest frame there is, at once.
		if (this.readySlot !== null) this.sendReady(false);
		else if (this.latestSlot !== null) {
			this.send(this.latestSlot, false, this.latestSlot !== this.sentSlot);
			this.again();
		}
	}

	stop() {
		this.stopped = true;
		this.watching = false;
		this.cancel();
	}

	/** `fresh`: a frame not sent before. */
	send(slot, follow, fresh) {
		if (!this.transmit(slot)) return;
		this.sentSlot = slot;
		const now = this.now();
		this.tally.count(fresh ? "fresh" : "repeats", 1, `slot ${slot}, ${(now - this.due).toFixed(1)} ms after due${follow ? ", followed" : ""}`);
		if (this.lastSentAt !== undefined) this.tally.time("send", now - this.lastSentAt);
		this.lastSentAt = now;
		if (this.anchor) {
			this.anchor = false;
			this.due = now + this.frameMs;
		} else this.due = nextDue({ due: this.due, now, frameMs: this.frameMs, follow });
		this.sentAt = now;
		this.sent++;
	}

	/** `follow`: it goes out the moment it was painted. */
	sendReady(follow) {
		const slot = this.readySlot;
		this.readySlot = null;
		this.send(slot, follow, true);
		this.again();
	}

	/** Half a frame after the next one is due, so one a little late is not sent twice. */
	again() {
		this.at(this.due + 0.5 * this.frameMs);
	}

	at(time) {
		this.cancel();
		if (!this.watching || this.stopped) return;
		this.timerDue = time;
		this.timer = this.timers.set(
			() => {
				this.timerDue = undefined;
				if (!this.watching || this.stopped) return;
				if (this.readySlot !== null) {
					this.sendReady(false);
					return;
				}
				if (this.sentSlot === null) return;
				this.send(this.sentSlot, false, false);
				this.again();
			},
			Math.max(0, time - this.now()),
		);
	}

	cancel() {
		this.timers.clear(this.timer);
		this.timer = undefined;
		this.timerDue = undefined;
	}
}
