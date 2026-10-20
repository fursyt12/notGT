/**
 * The CPU half of an out: each painted frame comes as a bitmap, the changed
 * rectangle of it is converted (see `frame.mjs`) and handed to NDI.
 *
 * When a frame goes out is the out's frame clock (`clock.mjs`), the same as
 * the GPU sinks': paints that come too soon are merged into the next frame —
 * their changed rectangles joined — so only the newest of them is converted,
 * when its turn comes; and while nothing is painted the last frame goes out
 * again at the out's rate.
 */
import { FrameClock } from "./clock.mjs";
import { FramePair, union } from "./frame.mjs";
import { Tally } from "./telemetry.mjs";

export class CpuSink {
	/**
	 * @param {object} options
	 * @param {import("./ndi.mjs").Ndi} options.ndi
	 * @param {import("./controller.mjs").OutputConfig} options.config
	 * @param {Tally} [options.tally] the out's: what becomes of its frames
	 */
	constructor({ ndi, config, tally = new Tally() }) {
		this.config = config;
		/** Frames come as bitmaps, not as shared textures. */
		this.shared = false;
		this.kind = "cpu";
		this.frames = new FramePair(config.width, config.height, {
			alpha: config.alpha,
		});
		this.sender = ndi.createSender(config.ndiName, { groups: config.groups });
		/** Time spent on frames: copying, converting, handing over. */
		this.busyMs = 0;
		/** The newest picture painted and not yet sent, and what changed. */
		this.pending = undefined;
		this.tally = tally;
		// One "slot": the picture waiting, or the last one sent again.
		this.clock = new FrameClock({
			fps: config.fps,
			transmit: () => this.transmit(),
			tally,
		});
		this.stopped = false;
	}

	get name() {
		return this.frames.simd ? "CPU (SIMD)" : "CPU";
	}

	get sent() {
		return this.clock.sent;
	}

	connections() {
		return this.sender.connections(0);
	}

	size() {
		return { width: this.frames.width, height: this.frames.height };
	}

	/** Receivers came, or went. */
	setWatching(watching) {
		this.pending = undefined;
		if (watching) {
			this.frames.invalidate();
			// The last frame sent may be from long ago; the keepalive waits for a fresh one.
			this.frames.current = null;
		}
		this.clock.setWatching(watching);
	}

	/** A painted picture, changed inside `dirty`. */
	paint(dirty, image) {
		const began = performance.now();
		this.handle(dirty, image);
		this.busyMs += performance.now() - began;
	}

	handle(dirty, image) {
		if (this.stopped || !this.clock.watching) return;
		const size = image.getSize();
		if (
			size.width !== this.frames.width ||
			size.height !== this.frames.height
		) {
			// The window came out another size than asked; follow the picture.
			this.sender.flush();
			this.pending = undefined;
			this.frames = new FramePair(size.width, size.height, {
				alpha: this.config.alpha,
			});
		}
		this.pending = {
			dirty: this.pending ? union(this.pending.dirty, dirty) : dirty,
			image,
		};
		this.clock.frameReady(0);
	}

	/**
	 * The clock's turn: the newest painted picture, converted where it
	 * changed — or, with none waiting, the last frame again (receivers want a
	 * steady rate: NDI compresses it again, nothing is drawn or converted).
	 */
	transmit() {
		if (this.stopped) return false;
		let buffer = this.frames.current;
		if (this.pending) {
			const began = performance.now();
			buffer = this.convertPending();
			const ms = performance.now() - began;
			this.busyMs += ms;
			this.tally.count("converted");
			this.tally.time("convert", ms);
		}
		if (!buffer) return false;
		this.sender.sendAsync(buffer, this.frames.width, this.frames.height, {
			fps: this.config.fps,
			opaque: !this.config.alpha,
		});
		return true;
	}

	convertPending() {
		const { dirty, image } = this.pending;
		this.pending = undefined;
		const full = this.frames.width;
		return this.frames.update(dirty, (rect) => {
			const whole =
				rect.x === 0 &&
				rect.y === 0 &&
				rect.width === full &&
				rect.height === this.frames.height;
			const data = (whole ? image : image.crop(rect)).toBitmap();
			return { data, stride: rowBytes(data, rect) };
		});
	}

	/** What the debug line says about the work, since it was last asked. */
	report(seconds) {
		const line = `${this.frames.converted} px converted, ${((this.busyMs / (seconds * 1000)) * 100).toFixed(1)}% of a core on frames`;
		this.busyMs = 0;
		return line;
	}

	async stop() {
		this.stopped = true;
		this.clock.stop();
		// Destroying the sender waits for NDI to let go of the last frame.
		this.sender.destroy();
	}
}

/** Bytes per row of a bitmap that holds `rect`, padding included. */
function rowBytes(data, rect) {
	if (rect.height <= 1) return rect.width * 4;
	return (data.length - rect.width * 4) / (rect.height - 1);
}
