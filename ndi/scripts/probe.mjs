#!/usr/bin/env node
/**
 * Looks at NDI from the receiving end — to check a sender without Resolume.
 *
 *   node scripts/probe.mjs                         lists the sources on the network
 *   node scripts/probe.mjs --source "notGT Main"   receives one for 5 s and reports
 *        [--seconds 5] [--pixel 960,540] [--save frame.pam] [--json]
 *        [--wait 3000] [--ips 10.0.0.5,10.0.0.6]   (where mDNS does not reach)
 *
 * `--source` matches any part of the name. `--save` writes the last frame as a
 * PAM image (RGBA), which GIMP and ImageMagick open.
 */
import fs from "node:fs";
import { loadNdi } from "../src/ndi.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (!arg.startsWith("--")) continue;
	const next = process.argv[i + 1];
	if (next !== undefined && !next.startsWith("--")) {
		args[arg.slice(2)] = next;
		i++;
	} else args[arg.slice(2)] = true;
}

const ndi = loadNdi();
const sources = ndi.findSources(
	Number(args.wait) || 3000,
	typeof args.ips === "string" ? args.ips : null,
);

if (!args.source) {
	if (sources.length === 0) console.log("No NDI sources found.");
	for (const source of sources)
		console.log(`${source.name}\t${source.url ?? ""}`);
	ndi.destroy();
	process.exit(0);
}

const source = sources.find((candidate) =>
	candidate.name.includes(String(args.source)),
);
if (!source) {
	console.error(
		`No source matches “${args.source}”. Found: ${sources.map((s) => s.name).join(", ") || "none"}`,
	);
	ndi.destroy();
	process.exit(1);
}

const receiver = ndi.createReceiver(source);
const seconds = Number(args.seconds) || 5;
const pixels = String(args.pixel ?? "")
	.split(";")
	.filter(Boolean)
	.map((pair) => pair.split(",").map(Number));

let frames = 0;
let first = 0;
let last;
const started = Date.now();
while (Date.now() - started < seconds * 1000) {
	const frame = receiver.captureVideo(500, (video) => video);
	if (!frame) continue;
	if (frames === 0) first = Date.now();
	frames++;
	last = frame;
}
const elapsed = frames > 1 ? (Date.now() - first) / 1000 : 0;

const report = {
	source: source.name,
	frames,
	receivedFps: elapsed ? Math.round((frames / elapsed) * 10) / 10 : 0,
};
if (last) {
	Object.assign(report, {
		width: last.width,
		height: last.height,
		fourcc: last.fourcc,
		declaredFps: Math.round(last.fps * 100) / 100,
	});
	let opaque = 0;
	let clear = 0;
	let partial = 0;
	for (let row = 0; row < last.height; row++) {
		for (let col = 0; col < last.width; col++) {
			const alpha = last.pixels[row * last.stride + col * 4 + 3];
			if (alpha === 255) opaque++;
			else if (alpha === 0) clear++;
			else partial++;
		}
	}
	report.alpha = { opaque, clear, partial };
	report.pixels = pixels.map(([x, y]) => {
		const at = y * last.stride + x * 4;
		const [b, g, r, a] = last.pixels.subarray(at, at + 4);
		return { x, y, r, g, b, a };
	});
	if (typeof args.save === "string") {
		const header = `P7\nWIDTH ${last.width}\nHEIGHT ${last.height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
		const body = Buffer.alloc(last.width * last.height * 4);
		for (let row = 0; row < last.height; row++) {
			for (let col = 0; col < last.width; col++) {
				const s = row * last.stride + col * 4;
				const d = (row * last.width + col) * 4;
				body[d] = last.pixels[s + 2];
				body[d + 1] = last.pixels[s + 1];
				body[d + 2] = last.pixels[s];
				body[d + 3] = last.pixels[s + 3];
			}
		}
		fs.writeFileSync(args.save, Buffer.concat([Buffer.from(header), body]));
		report.saved = args.save;
	}
}

console.log(args.json ? JSON.stringify(report) : report);
receiver.destroy();
ndi.destroy();
