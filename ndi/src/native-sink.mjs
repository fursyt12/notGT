/**
 * The native half of an out: each frame the out page paints comes as a
 * texture on the GPU (a dmabuf on Linux), and the native addon (native/,
 * Rust) converts it there, straight into memory NDI reads, and sends it.
 * The texture is a dmabuf on Linux, a D3D11 texture (an NT handle) on
 * Windows.
 * Pixels never pass through JavaScript, nor through another process:
 *
 *   paint ─ texture ─► native: import, convert on the GPU ─► NDI
 *
 * Here is only the policy: which slot a frame goes into, when it goes out
 * (`clock.mjs`), and when the texture goes back to Chromium — once the GPU
 * is done reading it.
 *
 * One frame is converted at a time; a paint that comes meanwhile waits, and
 * only the newest does, so the last picture of an animation is never the one
 * left behind.
 */
import { FrameClock } from "./clock.mjs";
import { Tally } from "./telemetry.mjs";

/**
 * How long a first frame may take once the page is loaded. Where Chromium
 * can draw on the GPU but not share what it drew, no frame ever comes.
 */
const FIRST_FRAME_MS = 5000;

export class NativeSink {
	/**
	 * Opens the GPU, checks it converts right, and opens the NDI source;
	 * throws, saying why, when any of it cannot be had.
	 * @param {object} options
	 * @param {any} options.native the addon (native.mjs)
	 * @param {import("./controller.mjs").OutputConfig} options.config
	 * @param {string} options.ndiFile the NDI library the main process opened
	 * @param {{ renderNode?: string, vendorId?: number, deviceId?: number }} [options.gpu]
	 *   the GPU Chromium draws on
	 * @param {(line: string) => void} options.log
	 * @param {(reason: string) => void} options.onFail another sink should take over
	 * @param {Tally} [options.tally] the out's: what becomes of its frames
	 */
	constructor({ native, config, ndiFile, gpu = {}, log, onFail, tally = new Tally() }) {
		this.config = config;
		this.log = log;
		this.onFail = onFail;
		this.debug = process.env.NOTGT_NDI_DEBUG ? log : () => {};
		/** Frames come as shared textures. */
		this.shared = true;
		this.kind = "gpu";
		this.failed = false;
		this.stopped = false;
		this.width = config.width;
		this.height = config.height;
		this.converting = false;
		/** The newest paint that had to wait. */
		this.waiting = undefined;
		this.warnedSync = false;
		this.totals = { frames: 0, imports: 0, gpuMs: 0, totalMs: 0 };
		this.tally = tally;

		this.out = new native.NativeOut({
			ndiFile,
			ndiName: config.ndiName,
			...(config.groups ? { groups: config.groups } : {}),
			fps: config.fps,
			alpha: config.alpha,
			...(gpu.renderNode ? { renderNode: gpu.renderNode } : {}),
			...(gpu.vendorId ? { vendorId: gpu.vendorId, deviceId: gpu.deviceId } : {}),
		});
		this.backend = this.out.backend;
		this.name = `GPU (${this.backend})`;
		try {
			const tested = this.out.selfTest();
			log(`${config.ndiName}: converting with ${this.backend}; ${tested}`);
		} catch (error) {
			this.out.close();
			throw error;
		}
		this.clock = new FrameClock({
			fps: config.fps,
			transmit: (slot) => this.out.send(slot),
			tally,
		});
	}

	get sent() {
		return this.clock.sent;
	}

	connections() {
		return this.failed || this.stopped ? 0 : this.out.connections();
	}

	size() {
		return { width: this.width, height: this.height };
	}

	setWatching(watching) {
		this.clock.setWatching(watching);
	}

	/** The out page has loaded: a first frame is due. */
	loaded() {
		if (this.framed || this.failed) return;
		clearTimeout(this.frameTimer);
		this.frameTimer = setTimeout(
			() => this.fail("no frame came as a shared texture"),
			FIRST_FRAME_MS,
		);
	}

	/** A painted frame, as a texture this sink has to release; painted at `paintedAt`. */
	paintTexture(texture, paintedAt = performance.now()) {
		if (this.failed || this.stopped) {
			texture.release();
			return;
		}
		if (!this.framed) {
			this.framed = true;
			clearTimeout(this.frameTimer);
		}
		this.tally.took();
		const painted = { texture, paintedAt };
		if (this.converting) {
			if (this.waiting) this.tally.count("replaced");
			this.letGo(this.waiting);
			this.waiting = painted;
			return;
		}
		this.convert(painted);
	}

	/** Gives a painted frame's texture back to Chromium. */
	letGo(painted) {
		if (!painted) return;
		painted.texture.release();
		this.tally.gaveBack(painted.paintedAt);
	}

	async convert(painted) {
		this.converting = true;
		this.tally.time("wait", performance.now() - painted.paintedAt);
		const { texture } = painted;
		try {
			const info = texture.textureInfo;
			const handle = info.handle ?? {};
			const { width, height } = info.codedSize;
			const visible = info.visibleRect;
			if (
				visible &&
				(visible.x || visible.y || visible.width !== width || visible.height !== height)
			)
				throw new Error(
					`the frame is ${width}×${height} with ${visible.width}×${visible.height} of it visible, which is not supported yet`,
				);
			const slot = this.clock.freeSlot();
			const frame = { width, height, format: info.pixelFormat };
			if (handle.nativePixmap) {
				frame.modifier = String(handle.nativePixmap.modifier);
				frame.planes = handle.nativePixmap.planes.map((p) => ({
					fd: p.fd,
					offset: p.offset,
					stride: p.stride,
				}));
			} else if (handle.ntHandle) frame.ntHandle = handle.ntHandle;
			else
				throw new Error(
					"frames come with no handle the native converter can import here",
				);
			const done = await this.out.convert(frame, slot);
			if (this.stopped) return;
			if (done.width !== this.width || done.height !== this.height) {
				// New memory for the new size: the other slots hold nothing.
				this.clock.reset();
				this.width = done.width;
				this.height = done.height;
			}
			if (!done.synced && !this.warnedSync) {
				this.warnedSync = true;
				this.log(
					`${this.config.ndiName}: ${
						process.platform === "win32"
							? "Electron gives no fence for frames on Windows"
							: "this kernel cannot say when Chromium has finished drawing a frame (Linux 6.0 or newer can)"
					}; frames are taken as they come`,
				);
			}
			const t = this.totals;
			t.frames++;
			if (done.imported) t.imports++;
			t.gpuMs += done.gpuMs;
			t.totalMs += done.totalMs;
			this.tally.count("converted");
			this.tally.time("convert", done.totalMs);
			this.clock.frameReady(slot);
		} catch (error) {
			this.fail(`the native converter could not convert a frame: ${error.message}`);
		} finally {
			// Only now: the GPU is done reading it.
			this.letGo(painted);
			this.converting = false;
		}
		const next = this.waiting;
		this.waiting = undefined;
		if (next) {
			if (this.failed || this.stopped) this.letGo(next);
			else this.convert(next);
		}
	}

	fail(reason) {
		if (this.failed || this.stopped) return;
		this.failed = true;
		clearTimeout(this.frameTimer);
		this.clock.stop();
		this.letGo(this.waiting);
		this.waiting = undefined;
		this.onFail(reason);
	}

	/** What the debug line says about the work, since it was last asked. */
	report() {
		const t = this.totals;
		const n = t.frames || 1;
		const line = `${t.frames} frames converted natively (${t.imports} imported), ${(t.gpuMs / n).toFixed(1)} ms on the GPU and ${(t.totalMs / n).toFixed(1)} ms in all each`;
		this.totals = { frames: 0, imports: 0, gpuMs: 0, totalMs: 0 };
		return line;
	}

	/** Takes the NDI source down; resolves once it is gone. */
	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.frameTimer);
		this.clock.stop();
		this.letGo(this.waiting);
		this.waiting = undefined;
		// Waits for NDI to let go of the last frame, and for the GPU.
		this.out.close();
	}
}
