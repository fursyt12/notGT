import zlib from "node:zlib";

export interface Rgba {
	width: number;
	height: number;
	/** width × height × 4 bytes, straight (not premultiplied) alpha. */
	data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Reads a PNG as Chromium writes a screenshot: 8 bits per channel, RGBA or
 * RGB, not interlaced. Anything else is refused rather than misread.
 */
export function decodePng(file: Uint8Array): Rgba {
	const view = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
	if (!SIGNATURE.every((byte, i) => view[i] === byte)) throw new Error("not a PNG");

	let width = 0;
	let height = 0;
	let channels = 0;
	const parts: Buffer[] = [];
	for (let at = 8; at + 8 <= view.length; ) {
		const length = view.readUInt32BE(at);
		const type = view.toString("latin1", at + 4, at + 8);
		const body = view.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			const depth = body[8];
			const color = body[9];
			const interlace = body[12];
			if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) {
				throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
			}
			channels = color === 6 ? 4 : 3;
		} else if (type === "IDAT") {
			parts.push(body);
		} else if (type === "IEND") {
			break;
		}
		at += 12 + length;
	}
	if (!width || !height || !channels) throw new Error("PNG without a header");

	const raw = zlib.inflateSync(Buffer.concat(parts));
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) throw new Error("PNG data is short");

	const pixels = new Uint8Array(stride * height);
	let previous = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = pixels.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? out[x - channels]! : 0;
			const up = previous[x]!;
			const corner = x >= channels ? previous[x - channels]! : 0;
			let value = line[x]!;
			switch (filter) {
				case 1:
					value += left;
					break;
				case 2:
					value += up;
					break;
				case 3:
					value += (left + up) >> 1;
					break;
				case 4: {
					const p = left + up - corner;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - corner);
					value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
					break;
				}
				default:
					break;
			}
			out[x] = value & 0xff;
		}
		previous = out;
	}

	if (channels === 4) return { width, height, data: pixels };
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
		rgba[j] = pixels[i]!;
		rgba[j + 1] = pixels[i + 1]!;
		rgba[j + 2] = pixels[i + 2]!;
		rgba[j + 3] = 255;
	}
	return { width, height, data: rgba };
}
