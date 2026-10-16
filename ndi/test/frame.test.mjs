import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FramePair,
	LUT,
	clip,
	copyOpaque,
	copyUnpremultiplied,
	union,
} from "../src/frame.mjs";
import { frameRate } from "../src/ndi.mjs";

/** One BGRA pixel as Chromium paints it: premultiplied. */
function premultiplied(r, g, b, a) {
	const k = a / 255;
	return [Math.round(b * k), Math.round(g * k), Math.round(r * k), a];
}

/** Reads any rectangle of a picture that is opaque grey `value` all over. */
function grey(value) {
	return (rect) => {
		const data = Buffer.alloc(rect.width * rect.height * 4, value);
		for (let i = 3; i < data.length; i += 4) data[i] = 255;
		return { data, stride: rect.width * 4 };
	};
}

test("the table divides the alpha out", () => {
	assert.equal(LUT[(128 << 8) | 128], 255);
	assert.equal(LUT[(128 << 8) | 64], 128);
	assert.equal(LUT[(255 << 8) | 200], 200);
	assert.equal(LUT[0], 0);
	// A channel above its alpha cannot come from premultiplying; it clamps.
	assert.equal(LUT[(10 << 8) | 200], 255);
});

test("union and clip", () => {
	assert.equal(union(null, null), null);
	assert.deepEqual(union(null, { x: 1, y: 2, width: 3, height: 4 }), {
		x: 1,
		y: 2,
		width: 3,
		height: 4,
	});
	assert.deepEqual(
		union(
			{ x: 0, y: 0, width: 2, height: 2 },
			{ x: 5, y: 5, width: 1, height: 1 },
		),
		{
			x: 0,
			y: 0,
			width: 6,
			height: 6,
		},
	);
	assert.deepEqual(clip({ x: -5, y: 3.5, width: 20, height: 2 }, 10, 10), {
		x: 0,
		y: 3,
		width: 10,
		height: 3,
	});
	assert.equal(clip({ x: 20, y: 0, width: 5, height: 5 }, 10, 10), null);
});

test("pixels come out with straight alpha, opaque and clear ones untouched", () => {
	const src = Buffer.from([
		...premultiplied(255, 255, 255, 128),
		...premultiplied(255, 0, 0, 255),
		0,
		0,
		0,
		0,
		...premultiplied(0, 128, 255, 64),
	]);
	const dst = Buffer.alloc(src.length);
	copyUnpremultiplied(src, 16, dst, 4, { x: 0, y: 0, width: 4, height: 1 });
	assert.deepEqual([...dst.subarray(0, 4)], [255, 255, 255, 128]);
	assert.deepEqual([...dst.subarray(4, 8)], [0, 0, 255, 255]);
	assert.deepEqual([...dst.subarray(8, 12)], [0, 0, 0, 0]);
	const [b, g, r, a] = dst.subarray(12, 16);
	assert.equal(a, 64);
	assert.ok(
		Math.abs(b - 255) <= 4 && Math.abs(g - 128) <= 4 && r === 0,
		`${b},${g},${r}`,
	);
});

test("an unaligned source takes the byte path and gives the same answer", () => {
	const pixels = [
		...premultiplied(200, 100, 50, 100),
		...premultiplied(10, 20, 30, 255),
	];
	const backing = Buffer.alloc(pixels.length + 1);
	Buffer.from(pixels).copy(backing, 1);
	const a = Buffer.alloc(8);
	const b = Buffer.alloc(8);
	copyUnpremultiplied(Buffer.from(pixels), 8, a, 2, {
		x: 0,
		y: 0,
		width: 2,
		height: 1,
	});
	copyUnpremultiplied(backing.subarray(1), 8, b, 2, {
		x: 0,
		y: 0,
		width: 2,
		height: 1,
	});
	assert.deepEqual([...a], [...b]);
});

test("a rectangle lands where it belongs in the frame", () => {
	const dst = Buffer.alloc(4 * 4 * 4);
	const red = premultiplied(255, 0, 0, 255);
	copyUnpremultiplied(
		Buffer.from([...red, ...red, ...red, ...red]),
		8,
		dst,
		4,
		{ x: 1, y: 2, width: 2, height: 2 },
	);
	const at = (x, y) => [...dst.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
	assert.deepEqual(at(1, 2), [0, 0, 255, 255]);
	assert.deepEqual(at(2, 3), [0, 0, 255, 255]);
	assert.deepEqual(at(0, 2), [0, 0, 0, 0]);
	assert.deepEqual(at(3, 3), [0, 0, 0, 0]);
});

test("the two buffers take turns and each catches up on what it missed", () => {
	const frames = new FramePair(8, 8);
	const reads = [];
	const reader = (value) => (rect) => {
		reads.push(rect);
		return grey(value)(rect);
	};
	const whole = { x: 0, y: 0, width: 8, height: 8 };

	// The first buffer starts stale everywhere.
	assert.equal(frames.update(whole, reader(10)), frames.buffers[0]);
	assert.deepEqual(reads.at(-1), whole);

	// So does the second, whatever changed.
	assert.equal(
		frames.update({ x: 0, y: 0, width: 2, height: 2 }, reader(20)),
		frames.buffers[1],
	);
	assert.deepEqual(reads.at(-1), whole);

	// The first buffer has missed the corner, and now the opposite corner.
	frames.update({ x: 6, y: 6, width: 2, height: 2 }, reader(30));
	assert.deepEqual(reads.at(-1), whole);

	// The second has missed only the last change.
	frames.update({ x: 6, y: 6, width: 2, height: 2 }, reader(40));
	assert.deepEqual(reads.at(-1), { x: 6, y: 6, width: 2, height: 2 });

	// From here on, a small change costs a small read.
	frames.update({ x: 3, y: 3, width: 1, height: 1 }, reader(50));
	assert.deepEqual(reads.at(-1), { x: 3, y: 3, width: 5, height: 5 });
	frames.update({ x: 3, y: 3, width: 1, height: 1 }, reader(60));
	assert.deepEqual(reads.at(-1), { x: 3, y: 3, width: 1, height: 1 });

	// Each buffer holds the picture it was last brought up to.
	assert.equal(frames.buffers[1][(3 * 8 + 3) * 4], 60);
	assert.equal(frames.buffers[0][(3 * 8 + 3) * 4], 50);
});

test("after invalidate both buffers are rewritten whole", () => {
	const frames = new FramePair(4, 4);
	const whole = { x: 0, y: 0, width: 4, height: 4 };
	frames.update(whole, grey(1));
	frames.update(whole, grey(1));
	frames.invalidate();
	let read;
	frames.update({ x: 1, y: 1, width: 1, height: 1 }, (rect) => {
		read = rect;
		return grey(2)(rect);
	});
	assert.deepEqual(read, whole);
});

test("opaque: premultiplied colour is the colour over black, alpha 255", () => {
	const src = Buffer.from([...premultiplied(255, 255, 255, 128), 0, 0, 0, 0]);
	const dst = Buffer.alloc(8);
	copyOpaque(src, 8, dst, 2, { x: 0, y: 0, width: 2, height: 1 });
	assert.deepEqual([...dst], [128, 128, 128, 255, 0, 0, 0, 255]);
	const backing = Buffer.alloc(9);
	src.copy(backing, 1);
	const bytes = Buffer.alloc(8);
	copyOpaque(backing.subarray(1), 8, bytes, 2, {
		x: 0,
		y: 0,
		width: 2,
		height: 1,
	});
	assert.deepEqual([...bytes], [...dst]);
});

test("an opaque pair converts nothing", () => {
	const frames = new FramePair(2, 1, { alpha: false });
	const half = premultiplied(255, 255, 255, 128);
	const buffer = frames.update({ x: 0, y: 0, width: 2, height: 1 }, () => ({
		data: Buffer.from([...half, ...half]),
		stride: 8,
	}));
	assert.deepEqual([...buffer.subarray(0, 4)], [128, 128, 128, 255]);
});

test("broadcast rates go out as n/1001, the rest as they are", () => {
	assert.deepEqual(frameRate(29.97), {
		frame_rate_N: 30000,
		frame_rate_D: 1001,
	});
	assert.deepEqual(frameRate(59.94), {
		frame_rate_N: 60000,
		frame_rate_D: 1001,
	});
	assert.deepEqual(frameRate(23.976), {
		frame_rate_N: 24000,
		frame_rate_D: 1001,
	});
	assert.deepEqual(frameRate(25), { frame_rate_N: 25000, frame_rate_D: 1000 });
	assert.deepEqual(frameRate(12.5), {
		frame_rate_N: 12500,
		frame_rate_D: 1000,
	});
});
