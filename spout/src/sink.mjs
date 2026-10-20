/**
 * An out as a Spout sender (Windows): each frame the out page paints is
 * drawn by the native addon (native/, Rust) into the D3D11 texture Spout
 * receivers on this computer open — Resolume, TouchDesigner, OBS with the
 * Spout2 plugin. Nothing goes over the network, and nothing is compressed.
 *
 *  - on the GPU (`shared`), the frame comes as Chromium's texture and stays
 *    on the GPU: one draw, no copy through memory;
 *  - on the CPU, the frame comes as a bitmap, and only the rectangle that
 *    changed is uploaded.
 *
 * Spout cannot tell who is receiving, so the page is painted at the out's
 * rate all the time; a picture that does not move is not drawn again —
 * receivers keep reading the texture as it is.
 *
 * One frame is drawn at a time; a paint that comes meanwhile waits, and only
 * the newest does.
 */

/** How long a first frame may take once the page is loaded (see NativeSink). */
const FIRST_FRAME_MS = 5000;

export class SpoutSink {
	/**
	 * Opens Direct3D 11 and lists the sender in Spout; throws, saying why,
	 * when either cannot be done.
	 * @param {object} options
	 * @param {any} options.native the addon (native.mjs)
	 * @param {import("../../ndi/src/controller.mjs").OutputConfig} options.config
	 * @param {boolean} options.shared frames come as Chromium's textures
	 * @param {{ vendorId?: number, deviceId?: number }} [options.gpu] the GPU Chromium draws on
	 * @param {(line: string) => void} options.log
	 * @param {(reason: string) => void} [options.onFail] another sink should take over
	 */
	constructor({ native, config, shared, gpu = {}, log, onFail = () => {} }) {
		this.config = config;
		this.log = log;
		this.onFail = onFail;
		this.shared = shared;
		this.kind = shared ? "gpu" : "cpu";
		this.failed = false;
		this.stopped = false;
		this.width = config.width;
		this.height = config.height;
		this.sent = 0;
		this.busy = false;
		/** The newest paint that had to wait: a texture, or a bitmap's rectangle. */
		this.waiting = undefined;
		this.totals = { frames: 0, skipped: 0, gpuMs: 0, totalMs: 0 };
		this.out = new native.SpoutOut({
			name: config.ndiName,
			alpha: config.alpha,
			shared,
			...(gpu.vendorId ? { vendorId: gpu.vendorId, deviceId: gpu.deviceId } : {}),
		});
		this.name = `Spout (${this.out.adapter})`;
		if (this.out.name !== config.ndiName)
			log(`${config.ndiName}: listed in Spout as “${this.out.name}”`);
	}

	/** Spout cannot count receivers: always as if one were watching. */
	connections() {
		return this.failed || this.stopped ? 0 : 1;
	}

	size() {
		return { width: this.width, height: this.height };
	}

	setWatching() {}

	/** The out page has loaded: a first frame is due. */
	loaded() {
		if (!this.shared || this.framed || this.failed) return;
		clearTimeout(this.frameTimer);
		this.frameTimer = setTimeout(
			() => this.fail("no frame came as a shared texture"),
			FIRST_FRAME_MS,
		);
	}

	/** A painted frame, as a texture this sink has to release. */
	paintTexture(texture) {
		if (this.failed || this.stopped) {
			texture.release();
			return;
		}
		if (!this.framed) {
			this.framed = true;
			clearTimeout(this.frameTimer);
		}
		if (this.busy) {
			this.waiting?.texture?.release();
			this.waiting = { texture };
			return;
		}
		this.draw({ texture });
	}

	/** A painted picture, changed inside `dirty`. */
	paint(dirty, image) {
		if (this.failed || this.stopped) return;
		const size = image.getSize();
		const waiting = this.waiting;
		// Paints merged while one is drawn: the newest picture, where any changed.
		const rect =
			waiting?.image && sameSize(waiting.size, size)
				? union(waiting.dirty, dirty)
				: dirty;
		this.waiting = { image, dirty: clip(rect, size), size };
		if (!this.busy) {
			const next = this.waiting;
			this.waiting = undefined;
			this.draw(next);
		}
	}

	async draw(frame) {
		this.busy = true;
		try {
			let done;
			if (frame.texture) {
				const info = frame.texture.textureInfo;
				const handle = info.handle?.ntHandle;
				if (!handle)
					throw new Error("frames come with no handle Spout can open here");
				const { width, height } = info.codedSize;
				done = await this.out.sendTexture({
					ntHandle: handle,
					width,
					height,
					...(info.visibleRect ? { visible: info.visibleRect } : {}),
				});
			} else if (frame.dirty.width > 0 && frame.dirty.height > 0) {
				const { image, dirty, size } = frame;
				const whole = dirty.width === size.width && dirty.height === size.height;
				const data = (whole ? image : image.crop(dirty)).toBitmap();
				done = await this.out.sendPixels(
					data,
					rowBytes(data, dirty),
					size.width,
					size.height,
					dirty,
				);
			}
			if (done && !this.stopped) {
				this.width = done.width;
				this.height = done.height;
				const t = this.totals;
				if (done.skipped) t.skipped++;
				else {
					this.sent++;
					t.frames++;
					t.gpuMs += done.gpuMs;
					t.totalMs += done.totalMs;
				}
			}
		} catch (error) {
			this.fail(`Spout could not take a frame: ${error.message}`);
		} finally {
			// Only now: the GPU is done reading it.
			frame.texture?.release();
			this.busy = false;
		}
		const next = this.waiting;
		this.waiting = undefined;
		if (next) {
			if (this.failed || this.stopped) next.texture?.release();
			else this.draw(next);
		}
	}

	fail(reason) {
		if (this.failed || this.stopped) return;
		this.failed = true;
		clearTimeout(this.frameTimer);
		this.waiting?.texture?.release();
		this.waiting = undefined;
		this.onFail(reason);
	}

	/** What the debug line says about the work, since it was last asked. */
	report() {
		const t = this.totals;
		const n = t.frames || 1;
		const line = `${t.frames} frames shared${t.skipped ? ` (${t.skipped} dropped: a receiver held the texture)` : ""}, ${(t.gpuMs / n).toFixed(1)} ms on the GPU and ${(t.totalMs / n).toFixed(1)} ms in all each`;
		this.totals = { frames: 0, skipped: 0, gpuMs: 0, totalMs: 0 };
		return line;
	}

	/** Takes the sender out of Spout's list. */
	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.frameTimer);
		this.waiting?.texture?.release();
		this.waiting = undefined;
		this.out.close();
	}
}

function sameSize(a, b) {
	return a.width === b.width && a.height === b.height;
}

function union(a, b) {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

/** `rect` inside the picture, in whole pixels. */
function clip(rect, size) {
	const x = Math.max(0, Math.floor(rect.x));
	const y = Math.max(0, Math.floor(rect.y));
	return {
		x,
		y,
		width: Math.max(0, Math.min(size.width, Math.ceil(rect.x + rect.width)) - x),
		height: Math.max(0, Math.min(size.height, Math.ceil(rect.y + rect.height)) - y),
	};
}

/** Bytes per row of a bitmap that holds `rect`, padding included. */
function rowBytes(data, rect) {
	if (rect.height <= 1) return rect.width * 4;
	return (data.length - rect.width * 4) / (rect.height - 1);
}
