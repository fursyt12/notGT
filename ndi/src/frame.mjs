/**
 * Turning what Chromium paints into what NDI takes, touching as few pixels as
 * possible.
 *
 * Chromium paints BGRA with premultiplied alpha; NDI's BGRA is straight
 * alpha. The conversion is one table lookup per channel, done only for the
 * part of the frame that changed: a lower third moving over an empty out
 * converts its own box, not the 2 million pixels around it.
 *
 * NDI reads a frame on its own threads after the send call has returned, so
 * there are two frame buffers: one being read by NDI while the other is
 * written. Each remembers the region it has missed since it was last written,
 * so a buffer is brought up to date by converting just that region.
 */

/** `LUT[alpha << 8 | channel]` = the channel with the alpha divided out. */
export const LUT = (() => {
	const table = new Uint8Array(256 * 256);
	for (let alpha = 1; alpha < 256; alpha++) {
		for (let channel = 0; channel <= alpha; channel++) {
			table[(alpha << 8) | channel] = Math.min(
				255,
				Math.round((channel * 255) / alpha),
			);
		}
		// A premultiplied channel never exceeds its alpha; clamp what would.
		for (let channel = alpha + 1; channel < 256; channel++)
			table[(alpha << 8) | channel] = 255;
	}
	return table;
})();

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** The smallest rectangle holding both; `null` is the empty rectangle. */
export function union(a, b) {
	if (!a) return b ? { ...b } : null;
	if (!b) return { ...a };
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

/** `rect` cut to the frame, rounded out to whole pixels; `null` when nothing is left. */
export function clip(rect, width, height) {
	if (!rect) return null;
	const x0 = Math.max(0, Math.floor(rect.x));
	const y0 = Math.max(0, Math.floor(rect.y));
	const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
	const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function words(buffer) {
	return buffer.byteOffset % 4 === 0
		? new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >>> 2)
		: null;
}

/**
 * Writes `rect` of a frame into `dst` (a whole frame, `dstWidth` pixels wide)
 * with the alpha divided out. `src` holds just that rectangle, `srcStride`
 * bytes per row. Little-endian only, as are all the machines NDI runs on.
 */
export function copyUnpremultiplied(src, srcStride, dst, dstWidth, rect) {
	const s32 = words(src);
	const d32 = words(dst);
	if (!s32 || !d32 || srcStride % 4 !== 0) {
		copyBytes(src, srcStride, dst, dstWidth, rect);
		return;
	}
	const srcWords = srcStride >>> 2;
	const lut = LUT;
	for (let row = 0; row < rect.height; row++) {
		let s = row * srcWords;
		let d = (rect.y + row) * dstWidth + rect.x;
		const end = s + rect.width;
		for (; s < end; s++, d++) {
			const pixel = s32[s];
			const alpha = pixel >>> 24;
			if (alpha === 255 || alpha === 0) {
				// Opaque needs nothing; transparent is all zeroes already.
				d32[d] = pixel;
				continue;
			}
			const base = alpha << 8;
			d32[d] =
				((alpha << 24) |
					(lut[base | ((pixel >>> 16) & 255)] << 16) |
					(lut[base | ((pixel >>> 8) & 255)] << 8) |
					lut[base | (pixel & 255)]) >>>
				0;
		}
	}
}

/**
 * Writes `rect` as an opaque picture: premultiplied colour is the colour over
 * black already, so it is copied as it is, with the alpha set to 255.
 */
export function copyOpaque(src, srcStride, dst, dstWidth, rect) {
	const s32 = words(src);
	const d32 = words(dst);
	if (!s32 || !d32 || srcStride % 4 !== 0) {
		for (let row = 0; row < rect.height; row++) {
			const from = row * srcStride;
			const to = ((rect.y + row) * dstWidth + rect.x) * 4;
			src.copy(dst, to, from, from + rect.width * 4);
			for (let a = to + 3; a < to + rect.width * 4; a += 4) dst[a] = 255;
		}
		return;
	}
	const srcWords = srcStride >>> 2;
	for (let row = 0; row < rect.height; row++) {
		let s = row * srcWords;
		let d = (rect.y + row) * dstWidth + rect.x;
		const end = s + rect.width;
		for (; s < end; s++, d++) d32[d] = (s32[s] | 0xff000000) >>> 0;
	}
}

function copyBytes(src, srcStride, dst, dstWidth, rect) {
	for (let row = 0; row < rect.height; row++) {
		let s = row * srcStride;
		let d = ((rect.y + row) * dstWidth + rect.x) * 4;
		for (let col = 0; col < rect.width; col++, s += 4, d += 4) {
			const alpha = src[s + 3];
			const base = alpha << 8;
			if (alpha === 255 || alpha === 0) {
				dst[d] = src[s];
				dst[d + 1] = src[s + 1];
				dst[d + 2] = src[s + 2];
			} else {
				dst[d] = LUT[base | src[s]];
				dst[d + 1] = LUT[base | src[s + 1]];
				dst[d + 2] = LUT[base | src[s + 2]];
			}
			dst[d + 3] = alpha;
		}
	}
}

/** Two frame buffers taking turns, each written only where it is out of date. */
export class FramePair {
	/** `alpha: false` keeps the picture opaque, over black. */
	constructor(width, height, { alpha = true } = {}) {
		this.width = width;
		this.height = height;
		this.copy = alpha ? copyUnpremultiplied : copyOpaque;
		this.buffers = [
			Buffer.alloc(width * height * 4),
			Buffer.alloc(width * height * 4),
		];
		/** What each buffer has missed since it was last written. */
		this.stale = [this.full(), this.full()];
		this.next = 0;
		/** The buffer last handed out, which NDI may still be reading. */
		this.current = null;
		/** Pixels converted so far — what the work costs, for the status line. */
		this.converted = 0;
	}

	full() {
		return { x: 0, y: 0, width: this.width, height: this.height };
	}

	/** Forget what the buffers hold, e.g. after painting was paused. */
	invalidate() {
		this.stale = [this.full(), this.full()];
	}

	/**
	 * A new picture came in, changed inside `dirty`. `read(rect)` returns that
	 * rectangle of the picture as `{ data, stride }`. Returns the buffer to send.
	 */
	update(dirty, read) {
		this.stale[0] = union(this.stale[0], dirty);
		this.stale[1] = union(this.stale[1], dirty);
		const index = this.next;
		const rect = clip(this.stale[index], this.width, this.height);
		if (rect) {
			const { data, stride } = read(rect);
			this.copy(data, stride, this.buffers[index], this.width, rect);
			this.converted += rect.width * rect.height;
		}
		this.stale[index] = null;
		this.next = 1 - index;
		this.current = this.buffers[index];
		return this.current;
	}
}
