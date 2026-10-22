import fs, { type FileHandle } from "node:fs/promises";

import type { Rgba } from "./png";

/**
 * Resolume DXV3 with alpha, written by notGT itself: ffmpeg's DXV encoder
 * makes DXT1 only, which has no alpha.
 *
 * A frame is a 12-byte header and a DXT5 texture of the picture: 4×4 blocks of
 * 16 bytes, row by row, over the width rounded up to 16 and the height to 4.
 * The colour is premultiplied by the alpha, as DXV keeps it. The texture is
 * stored as it is, flagged "raw" in the header, as Resolume's own encoder does
 * when compressing would not pay; that makes big files (about 2 MB a frame
 * at 1080p) and no work for the player to unpack.
 *
 * The frames go into a QuickTime file with the `DXD3` sample description.
 */

const DXT5_TAG = 0x44585435; // "DXT5", read little-endian by the decoder
const HEADER_BYTES = 12;

const align = (value: number, to: number) => Math.ceil(value / to) * to;

/** One frame as a DXV3 packet. */
export function encodeDxvFrame(frame: Rgba): Uint8Array {
	const { width, height, data } = frame;
	const blocksX = align(width, 16) / 4;
	const blocksY = align(height, 4) / 4;
	const textureBytes = blocksX * blocksY * 16;
	const out = new Uint8Array(HEADER_BYTES + textureBytes);
	const view = new DataView(out.buffer);
	view.setUint32(0, DXT5_TAG, true);
	out[4] = 4; // version 3, stored + 1
	out[5] = 0;
	out[6] = 1; // raw texture
	out[7] = 0;
	view.setUint32(8, textureBytes, true);

	const pixels = new Uint8Array(64);
	for (let by = 0; by < blocksY; by++) {
		for (let bx = 0; bx < blocksX; bx++) {
			let opaque = false;
			for (let y = 0; y < 4; y++) {
				const sy = by * 4 + y;
				for (let x = 0; x < 4; x++) {
					const sx = bx * 4 + x;
					const p = (y * 4 + x) * 4;
					if (sx >= width || sy >= height) {
						pixels[p] = pixels[p + 1] = pixels[p + 2] = pixels[p + 3] = 0;
						continue;
					}
					const s = (sy * width + sx) * 4;
					const a = data[s + 3]!;
					pixels[p] = premultiply(data[s]!, a);
					pixels[p + 1] = premultiply(data[s + 1]!, a);
					pixels[p + 2] = premultiply(data[s + 2]!, a);
					pixels[p + 3] = a;
					if (a !== 0) opaque = true;
				}
			}
			// A block nobody can see is all zero bytes, which the buffer already is.
			if (opaque) encodeBlock(pixels, out, HEADER_BYTES + (by * blocksX + bx) * 16);
		}
	}
	return out;
}

function premultiply(value: number, alpha: number): number {
	return Math.round((value * alpha) / 255);
}

/** One DXT5 block: the alpha half, then the colour half. */
function encodeBlock(pixels: Uint8Array, out: Uint8Array, at: number): void {
	encodeAlpha(pixels, out, at);
	encodeColour(pixels, out, at + 8);
}

function encodeAlpha(pixels: Uint8Array, out: Uint8Array, at: number): void {
	let low = 255;
	let high = 0;
	for (let i = 3; i < 64; i += 4) {
		const a = pixels[i]!;
		if (a < low) low = a;
		if (a > high) high = a;
	}
	out[at] = high;
	out[at + 1] = low;
	if (high === low) return; // every index 0: alpha0

	// alpha0 > alpha1: eight steps, alpha0 at index 0, alpha1 at index 1 and
	// the six between them at 2..7 going down; the nearest step is found
	// directly, the steps being evenly spaced.
	const span = high - low;
	let first = 0;
	let second = 0;
	for (let i = 0; i < 16; i++) {
		const step = Math.round(((pixels[i * 4 + 3]! - low) * 7) / span);
		const index = step === 7 ? 0 : step === 0 ? 1 : 8 - step;
		if (i < 8) first |= index << (3 * i);
		else second |= index << (3 * (i - 8));
	}
	out[at + 2] = first & 0xff;
	out[at + 3] = (first >> 8) & 0xff;
	out[at + 4] = (first >> 16) & 0xff;
	out[at + 5] = second & 0xff;
	out[at + 6] = (second >> 8) & 0xff;
	out[at + 7] = (second >> 16) & 0xff;
}

function to565(r: number, g: number, b: number): number {
	r = r < 0 ? 0 : r > 255 ? 255 : r;
	g = g < 0 ? 0 : g > 255 ? 255 : g;
	b = b < 0 ? 0 : b > 255 ? 255 : b;
	return (Math.round((r * 31) / 255) << 11) | (Math.round((g * 63) / 255) << 5) | Math.round((b * 31) / 255);
}

/** The four colours of a block, widened from 5:6:5 the way the decoder does. */
const palette = new Int32Array(12);

function fillPalette(c0: number, c1: number): void {
	widen(c0, 0);
	widen(c1, 3);
	for (let k = 0; k < 3; k++) {
		palette[6 + k] = Math.floor((2 * palette[k]! + palette[3 + k]!) / 3);
		palette[9 + k] = Math.floor((2 * palette[3 + k]! + palette[k]!) / 3);
	}
}

function widen(colour: number, at: number): void {
	const r = (colour >> 11) * 255 + 16;
	const g = ((colour >> 5) & 0x3f) * 255 + 32;
	const b = (colour & 0x1f) * 255 + 16;
	palette[at] = ((r >> 5) + r) >> 5;
	palette[at + 1] = ((g >> 6) + g) >> 6;
	palette[at + 2] = ((b >> 5) + b) >> 5;
}

/** The index picked per pixel by the last `pickIndices`, 2 bits each. */
let picked = new Uint8Array(16);

/** Picks the nearest palette colour per pixel; returns the total error. */
function pickIndices(pixels: Uint8Array, into: Uint8Array): number {
	let total = 0;
	for (let i = 0; i < 16; i++) {
		const r = pixels[i * 4]!;
		const g = pixels[i * 4 + 1]!;
		const b = pixels[i * 4 + 2]!;
		let best = 0;
		let bestError = 1e9;
		for (let k = 0; k < 4; k++) {
			const dr = palette[k * 3]! - r;
			const dg = palette[k * 3 + 1]! - g;
			const db = palette[k * 3 + 2]! - b;
			const error = dr * dr + dg * dg + db * db;
			if (error < bestError) {
				bestError = error;
				best = k;
			}
		}
		total += bestError;
		into[i] = best;
	}
	return total;
}

/** Weights of colour0 and colour1 in each of the four palette entries. */
const WEIGHT0 = [1, 0, 2 / 3, 1 / 3];
const WEIGHT1 = [0, 1, 1 / 3, 2 / 3];
let trial = new Uint8Array(16);

function encodeColour(pixels: Uint8Array, out: Uint8Array, at: number): void {
	// A block of one colour: both ends that colour.
	let flat = true;
	for (let i = 4; i < 64 && flat; i += 4) {
		flat = pixels[i] === pixels[0] && pixels[i + 1] === pixels[1] && pixels[i + 2] === pixels[2];
	}
	if (flat) {
		const c = to565(pixels[0]!, pixels[1]!, pixels[2]!);
		writeColour(out, at, c, c, null);
		return;
	}

	// The line through the colours: their mean and main direction.
	let mr = 0;
	let mg = 0;
	let mb = 0;
	for (let i = 0; i < 64; i += 4) {
		mr += pixels[i]!;
		mg += pixels[i + 1]!;
		mb += pixels[i + 2]!;
	}
	mr /= 16;
	mg /= 16;
	mb /= 16;
	let rr = 0;
	let rg = 0;
	let rb = 0;
	let gg = 0;
	let gb = 0;
	let bb = 0;
	for (let i = 0; i < 64; i += 4) {
		const r = pixels[i]! - mr;
		const g = pixels[i + 1]! - mg;
		const b = pixels[i + 2]! - mb;
		rr += r * r;
		rg += r * g;
		rb += r * b;
		gg += g * g;
		gb += g * b;
		bb += b * b;
	}
	let vr = 1;
	let vg = 1;
	let vb = 1;
	for (let i = 0; i < 6; i++) {
		const nr = rr * vr + rg * vg + rb * vb;
		const ng = rg * vr + gg * vg + gb * vb;
		const nb = rb * vr + gb * vg + bb * vb;
		const length = Math.max(Math.abs(nr), Math.abs(ng), Math.abs(nb));
		if (length < 1e-9) break;
		vr = nr / length;
		vg = ng / length;
		vb = nb / length;
	}
	let low = Infinity;
	let high = -Infinity;
	for (let i = 0; i < 64; i += 4) {
		const t = (pixels[i]! - mr) * vr + (pixels[i + 1]! - mg) * vg + (pixels[i + 2]! - mb) * vb;
		if (t < low) low = t;
		if (t > high) high = t;
	}
	const norm = vr * vr + vg * vg + vb * vb || 1;
	// Pulled in by 1/16 of the span: the ends of the line are rarely hit exactly.
	const inset = (high - low) / 16;
	const t0 = (high - inset) / norm;
	const t1 = (low + inset) / norm;
	let c0 = to565(mr + vr * t0, mg + vg * t0, mb + vb * t0);
	let c1 = to565(mr + vr * t1, mg + vg * t1, mb + vb * t1);
	fillPalette(c0, c1);
	let error = pickIndices(pixels, picked);

	// One least-squares pass over the two ends, kept only if it is better.
	if (error > 0) {
		let aa = 0;
		let ab = 0;
		let bw = 0;
		let ar = 0;
		let ag = 0;
		let ab2 = 0;
		let br = 0;
		let bg = 0;
		let bb2 = 0;
		for (let i = 0; i < 16; i++) {
			const wa = WEIGHT0[picked[i]!]!;
			const wb = WEIGHT1[picked[i]!]!;
			aa += wa * wa;
			ab += wa * wb;
			bw += wb * wb;
			ar += wa * pixels[i * 4]!;
			ag += wa * pixels[i * 4 + 1]!;
			ab2 += wa * pixels[i * 4 + 2]!;
			br += wb * pixels[i * 4]!;
			bg += wb * pixels[i * 4 + 1]!;
			bb2 += wb * pixels[i * 4 + 2]!;
		}
		const det = aa * bw - ab * ab;
		if (Math.abs(det) > 1e-6) {
			const r0 = to565((bw * ar - ab * br) / det, (bw * ag - ab * bg) / det, (bw * ab2 - ab * bb2) / det);
			const r1 = to565((aa * br - ab * ar) / det, (aa * bg - ab * ag) / det, (aa * bb2 - ab * ab2) / det);
			fillPalette(r0, r1);
			const refined = pickIndices(pixels, trial);
			if (refined < error) {
				c0 = r0;
				c1 = r1;
				error = refined;
				const swap = picked;
				picked = trial;
				trial = swap;
			}
		}
	}
	writeColour(out, at, c0, c1, picked);
}

function writeColour(out: Uint8Array, at: number, c0: number, c1: number, indices: Uint8Array | null): void {
	out[at] = c0 & 0xff;
	out[at + 1] = c0 >> 8;
	out[at + 2] = c1 & 0xff;
	out[at + 3] = c1 >> 8;
	if (!indices) return; // every index 0
	for (let row = 0; row < 4; row++) {
		out[at + 4 + row] =
			indices[row * 4]! | (indices[row * 4 + 1]! << 2) | (indices[row * 4 + 2]! << 4) | (indices[row * 4 + 3]! << 6);
	}
}

// ---------------------------------------------------------------- QuickTime

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
	const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint32(0, size);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	let at = 8;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Big-endian fields: [bytes, value] pairs, or a string written as it is. */
function fields(...list: Array<[1 | 2 | 4 | 8, number] | string>): Uint8Array {
	const size = list.reduce((sum, item) => sum + (typeof item === "string" ? item.length : item[0]), 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const item of list) {
		if (typeof item === "string") {
			for (let i = 0; i < item.length; i++) out[at + i] = item.charCodeAt(i) & 0xff;
			at += item.length;
			continue;
		}
		const [bytes, value] = item;
		if (bytes === 1) view.setUint8(at, value);
		else if (bytes === 2) view.setUint16(at, value);
		else if (bytes === 4) view.setUint32(at, value >>> 0);
		else view.setBigUint64(at, BigInt(value));
		at += bytes;
	}
	return out;
}

const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map((v): [4, number] => [4, v]);

function pascal(text: string, size: number): string {
	const body = text.slice(0, size - 1);
	return String.fromCharCode(body.length) + body + "\0".repeat(size - 1 - body.length);
}

/**
 * Writes DXV3 packets into a `.mov`: the media data first, the index (`moov`)
 * at the end, 64-bit chunk offsets so a long render may pass 4 GB.
 */
export class DxvMovWriter {
	private handle: FileHandle | null = null;
	private position = 0;
	private readonly sizes: number[] = [];
	private readonly offsets: number[] = [];
	private readonly mdatAt = 20;

	constructor(
		private readonly file: string,
		private readonly width: number,
		private readonly height: number,
		private readonly fps: number,
	) {}

	async open(): Promise<void> {
		this.handle = await fs.open(this.file, "w");
		const ftyp = box("ftyp", fields("qt  ", [4, 0x200], "qt  "));
		// `mdat` with a 64-bit size, filled in at the end.
		const mdat = fields([4, 1], "mdat", [8, 0]);
		await this.write(ftyp);
		await this.write(mdat);
	}

	async add(packet: Uint8Array): Promise<void> {
		this.offsets.push(this.position);
		this.sizes.push(packet.length);
		await this.write(packet);
	}

	get frames(): number {
		return this.sizes.length;
	}

	async close(): Promise<void> {
		if (!this.handle) return;
		const mdatSize = this.position - this.mdatAt;
		await this.handle.write(fields([8, mdatSize]), 0, 8, this.mdatAt + 8);
		await this.write(this.moov());
		await this.handle.close();
		this.handle = null;
	}

	/** Drops the file half written (a cancelled or failed render). */
	async abort(): Promise<void> {
		await this.handle?.close().catch(() => {});
		this.handle = null;
		await fs.rm(this.file, { force: true });
	}

	private async write(bytes: Uint8Array): Promise<void> {
		await this.handle!.write(bytes, 0, bytes.length, this.position);
		this.position += bytes.length;
	}

	private moov(): Uint8Array {
		const count = this.sizes.length;
		const timescale = this.fps * 100;
		const delta = 100;
		const mediaDuration = count * delta;
		const movieDuration = Math.round((count * 1000) / this.fps);

		const mvhd = box(
			"mvhd",
			fields([4, 0], [4, 0], [4, 0], [4, 1000], [4, movieDuration], [4, 0x10000], [2, 0x100], [2, 0], [8, 0]),
			fields(...MATRIX),
			fields([4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 2]),
		);
		const tkhd = box(
			"tkhd",
			fields([4, 0xf], [4, 0], [4, 0], [4, 1], [4, 0], [4, movieDuration], [8, 0], [2, 0], [2, 0], [2, 0], [2, 0]),
			fields(...MATRIX),
			fields([4, this.width * 0x10000], [4, this.height * 0x10000]),
		);
		const mdhd = box("mdhd", fields([4, 0], [4, 0], [4, 0], [4, timescale], [4, mediaDuration], [2, 0], [2, 0]));
		const hdlr = box("hdlr", fields([4, 0], "mhlr", "vide", [4, 0], [4, 0], [4, 0], pascal("VideoHandler", 13)));
		const vmhd = box("vmhd", fields([4, 1], [2, 0x40], [2, 0x8000], [2, 0x8000], [2, 0x8000]));
		const dhlr = box("hdlr", fields([4, 0], "dhlr", "alis", [4, 0], [4, 0], [4, 0], pascal("DataHandler", 12)));
		const dinf = box("dinf", box("dref", fields([4, 0], [4, 1]), box("alis", fields([4, 1]))));
		const entry = box(
			"DXD3",
			fields([4, 0], [2, 0], [2, 1]),
			fields([2, 0], [2, 0], [4, 0], [4, 0], [4, 0x200]),
			fields([2, this.width], [2, this.height], [4, 0x480000], [4, 0x480000], [4, 0], [2, 1]),
			fields(pascal("Resolume DXV", 32), [2, 32], [2, 0xffff]),
		);
		const stsd = box("stsd", fields([4, 0], [4, 1]), entry);
		const stts = box("stts", fields([4, 0], [4, 1], [4, count], [4, delta]));
		const stsc = box("stsc", fields([4, 0], [4, 1], [4, 1], [4, 1], [4, 1]));
		const stsz = box("stsz", fields([4, 0], [4, 0], [4, count], ...this.sizes.map((size): [4, number] => [4, size])));
		const co64 = box("co64", fields([4, 0], [4, count], ...this.offsets.map((offset): [8, number] => [8, offset])));
		const stbl = box("stbl", stsd, stts, stsc, stsz, co64);
		const minf = box("minf", vmhd, dhlr, dinf, stbl);
		const mdia = box("mdia", mdhd, hdlr, minf);
		const trak = box("trak", tkhd, mdia);
		return box("moov", mvhd, trak);
	}
}
