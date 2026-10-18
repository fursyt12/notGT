/**
 * The native addon end to end, without a GPU: Mesa's lavapipe converts the
 * self-test picture, the addon's NDI source sends it, and a real NDI
 * receiver gets it back — colours, alpha and layout checked.
 *
 * Skipped, saying why, where the addon, the NDI library or Vulkan is not
 * there. In the sender's test image:
 *
 *   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
 *   NDI_LIB=/sdk/lib/x86_64-linux-gnu/libndi.so.6 node --test test/native.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNative } from "../src/native.mjs";

const native = loadNative();
let ndi;
let ndiProblem;
try {
	ndi = (await import("../src/ndi.mjs")).loadNdi();
} catch (error) {
	ndiProblem = error.message;
}

test("probe says, for every GPU, whether it can take frames and why not", (t) => {
	if (!native.module) return t.skip(native.why);
	const result = native.module.probe(undefined);
	if (result.error) return t.skip(result.error);
	assert.ok(result.devices.length > 0);
	for (const d of result.devices) {
		assert.equal(d.usable, !d.why, d.name);
		if (d.kind === "cpu") assert.equal(d.usable, false, `${d.name} is software`);
	}
});

test("an out refuses a GPU emulated on the CPU, saying so", (t) => {
	if (!native.module) return t.skip(native.why);
	if (!ndi) return t.skip(ndiProblem);
	const result = native.module.probe(undefined);
	if (result.error) return t.skip(result.error);
	if (result.devices.some((d) => d.usable))
		return t.skip("a real GPU is here; this is for machines without one");
	assert.throws(
		() =>
			new native.module.NativeOut({
				ndiFile: ndi.file,
				ndiName: "notGT native refusal",
				fps: 30,
				alpha: true,
			}),
		(error) => {
			assert.match(error.message, /emulating|cannot import/);
			return true;
		},
	);
});

/** The self-test picture's 8×8 blocks (reference.rs `test_pattern`), straight. */
const BLOCKS = [
	[255, 0, 0, 255],
	[0, 255, 0, 255],
	[0, 0, 255, 255],
	[255, 255, 255, 255],
	[128, 128, 128, 255],
	[32, 32, 32, 255],
	[255, 128, 0, 255],
	[0, 0, 0, 0],
];

test("what the addon sends is what an NDI receiver gets", (t) => {
	if (!native.module) return t.skip(native.why);
	if (!ndi) return t.skip(ndiProblem);
	const name = `notGT native ${process.pid}`;
	let out;
	try {
		out = new native.module.NativeOut({
			ndiFile: ndi.file,
			ndiName: name,
			fps: 30,
			alpha: true,
			allowSoftware: true,
			shared: false,
		});
	} catch (error) {
		return t.skip(`no Vulkan device: ${error.message}`);
	}
	try {
		assert.match(out.selfTest(), /to the byte/);
		const source = ndi
			.findSources(4000, "127.0.0.1")
			.find((s) => s.name.endsWith(`(${name})`));
		assert.ok(source, "the source is on the network");
		const receiver = ndi.createReceiver(source, "notGT native test");
		let frame;
		try {
			for (let i = 0; i < 100 && !frame; i++) {
				assert.ok(out.send(0), "slot 0 has the self-test picture");
				frame = receiver.captureVideo(100, (f) => ({ ...f, pixels: Buffer.from(f.pixels) }));
			}
		} finally {
			receiver.destroy();
		}
		assert.ok(frame, "a frame came");
		assert.equal(frame.width, 64);
		assert.equal(frame.height, 32);
		assert.equal(frame.fps, 30);
		// NDI compresses: a little off is NDI's, a lot off is a wrong layout.
		BLOCKS.forEach((want, k) => {
			const x = 8 * k + 4;
			const y = 4;
			const at = y * frame.stride + x * 4;
			const [b, g, r, a] = frame.pixels.subarray(at, at + 4);
			assert.ok(Math.abs(a - want[3]) <= 4, `block ${k}: alpha ${a}, not ${want[3]}`);
			if (want[3] < 64) return;
			for (const [got, wanted, channel] of [
				[r, want[0], "red"],
				[g, want[1], "green"],
				[b, want[2], "blue"],
			])
				assert.ok(
					Math.abs(got - wanted) <= 16,
					`block ${k}: ${channel} ${got}, not ${wanted}`,
				);
		});
	} finally {
		out.close();
	}
});
