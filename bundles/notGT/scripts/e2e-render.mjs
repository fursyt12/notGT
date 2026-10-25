#!/usr/bin/env node
/**
 * notGT render test: an animation rendered to a video file with alpha.
 *
 *   1. a code animation with a known fade is rendered in every format the
 *      server can make (WebM VP9, ProRes 4444, DXV3); each file has the codec,
 *      the frame count and, frame by frame, the alpha the fade gives;
 *   2. a `layers` animation (CSS transitions) comes out whole: transparent at
 *      the start and the end, opaque in the middle; a loop finds its own
 *      length from two endless animations, and its last frame leads into the first;
 *   3. a second render while one runs is refused, and a render can be stopped.
 *
 * The frames are read back with ffmpeg on this machine; without it the
 * checks of the pictures are skipped. The server needs a Chromium, Chrome or
 * Edge; without one the whole test is skipped.
 *
 * Usage (server must already be running, sign-in off):
 *   NOTGT_BASE=http://127.0.0.1:9191 node scripts/e2e-render.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", ".e2e");
const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const RENDER = "/bundles/notGT/render";

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

async function api(method, url, body, allow = []) {
	const response = await fetch(`${BASE}${url}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!response.ok && !allow.includes(response.status)) {
		throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
	}
	return { status: response.status, json };
}

async function render(templateId, format, holdMs) {
	const { json } = await api("POST", `${RENDER}/jobs`, { templateId, format, fps: 25, holdMs });
	let job = json.job;
	const until = Date.now() + 120_000;
	while (job.state === "running" && Date.now() < until) {
		await sleep(300);
		job = (await api("GET", `${RENDER}/jobs/${job.id}`)).json.job;
	}
	return job;
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

/** The alpha of one pixel in every frame of a file. */
function alphaAt(file, format, width, height, x, y) {
	// VP9 keeps the alpha in a side channel only libvpx's decoder reads.
	const decoder = format === "webm" ? ["-c:v", "libvpx-vp9"] : [];
	const raw = execFileSync(
		"ffmpeg",
		["-v", "error", ...decoder, "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
		{ maxBuffer: 1 << 30 },
	);
	const frameBytes = width * height * 4;
	const values = [];
	for (let at = 0; at + frameBytes <= raw.length; at += frameBytes) values.push(raw[at + (y * width + x) * 4 + 3]);
	return values;
}

function probe(file) {
	return execFileSync("ffprobe", [
		"-v", "error", "-show_entries", "stream=codec_name,codec_tag_string,width,height", "-of", "json", file,
	]).toString();
}

const EXPECTED_CODEC = { webm: "vp9", prores: "prores", dxv: "dxv" };

async function main() {
	fs.mkdirSync(outDir, { recursive: true });
	const { json: status } = await api("GET", `${RENDER}/status`);
	if (!status.browser) {
		console.log("SKIP  the server has no Chromium, Chrome or Edge to render with");
		process.exit(0);
	}
	const formats = status.ffmpeg ? ["webm", "prores", "dxv"] : ["dxv"];
	if (!hasFfmpeg) console.log("NOTE  no ffmpeg here: the frames are not read back");

	await api("POST", "/api/templates", {
		id: "e2e-render-code",
		name: "E2E render code",
		kind: "code",
		width: 320,
		height: 180,
		layers: [],
		code: {
			html: '<div id="box" style="position:absolute;inset:0;background:#ff0000;opacity:0"></div>',
			css: "",
			js:
				"const box = document.getElementById('box');" +
				"onShow(() => { box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, easing: 'linear', fill: 'forwards' }); });" +
				"onHide(() => { box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'linear', fill: 'forwards' }).finished.then(hideDone); }, 400);",
		},
	});
	await api("POST", "/api/templates", {
		id: "e2e-render-layers",
		name: "E2E render layers",
		kind: "layers",
		width: 320,
		height: 180,
		layers: [
			{
				id: "box",
				type: "shape",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				style: { fill: "#0000ff", opacity: 1, rotation: 0 },
				z: 1,
			},
		],
		inTransition: { type: "fade", durationMs: 400, easing: "linear" },
		outTransition: { type: "fade", durationMs: 400, easing: "linear" },
	});

	try {
		// --- 1. the fade, frame by frame, in every format ------------------
		for (const format of formats) {
			const job = await render("e2e-render-code", format, 1200);
			check(`${format}: the render finishes`, job.state === "done", job.error ?? job.state);
			if (job.state !== "done") continue;
			// 30 frames on screen at 25 fps, then about 10 of exit.
			check(`${format}: frames for 1.2 s on screen and the exit`, job.frames >= 39 && job.frames <= 43, `${job.frames}`);

			const response = await fetch(`${BASE}${RENDER}/files/${encodeURIComponent(job.file)}`);
			const file = path.join(outDir, job.file);
			fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
			check(
				`${format}: the file downloads as an attachment`,
				response.ok && /attachment/.test(response.headers.get("content-disposition") ?? ""),
				`${response.status} ${response.headers.get("content-type")}`,
			);
			if (!hasFfmpeg) continue;

			const info = JSON.parse(probe(file)).streams?.[0] ?? {};
			check(
				`${format}: codec and size`,
				info.codec_name === EXPECTED_CODEC[format] && info.width === 320 && info.height === 180,
				JSON.stringify(info),
			);
			const alpha = alphaAt(file, format, 320, 180, 160, 90);
			const near = (value, expected) => Math.abs(value - expected) <= 8;
			check(
				`${format}: the fade is drawn frame by frame`,
				alpha.length === job.frames &&
					alpha[0] === 0 &&
					near(alpha[5], 51) &&
					near(alpha[10], 102) &&
					near(alpha[20], 204) &&
					alpha[28] === 255 &&
					alpha[alpha.length - 1] < 60,
				alpha.join(" "),
			);
		}

		// --- 2. a layers animation -----------------------------------------
		const layers = await render("e2e-render-layers", "dxv", 800);
		check("layers: the render finishes", layers.state === "done", layers.error ?? layers.state);
		if (layers.state === "done" && hasFfmpeg) {
			const response = await fetch(`${BASE}${RENDER}/files/${encodeURIComponent(layers.file)}`);
			const file = path.join(outDir, layers.file);
			fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
			const alpha = alphaAt(file, "dxv", 320, 180, 20, 20);
			check(
				"layers: its transitions come in and go out",
				alpha[0] === 0 && Math.max(...alpha) === 255 && alpha[alpha.length - 1] < 60,
				alpha.join(" "),
			);
		}

		// --- 2b. one seamless loop ------------------------------------------
		// Two endless animations, back and forth every 1 s and round every
		// 0.6 s, after a 0.3 s entrance: one loop is 3 s, 75 frames at 25 fps,
		// and the frame after the last would be the first again.
		await api("POST", "/api/templates", {
			id: "e2e-render-loop",
			name: "E2E render loop",
			kind: "code",
			width: 320,
			height: 180,
			layers: [],
			code: {
				html:
					'<div id="a" style="position:absolute;left:0;top:0;width:160px;height:180px;background:#00ff00"></div>' +
					'<div id="b" style="position:absolute;left:160px;top:0;width:160px;height:180px;background:#00ff00"></div>',
				css: "",
				js:
					"const a = document.getElementById('a'), b = document.getElementById('b');" +
					"onShow(() => {" +
					" a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'backwards' });" +
					" a.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 500, delay: 300, iterations: Infinity, direction: 'alternate', easing: 'linear' });" +
					" b.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 600, iterations: Infinity, easing: 'linear' });" +
					"});",
			},
		});
		const { json: looped } = await api("POST", `${RENDER}/jobs`, {
			templateId: "e2e-render-loop",
			format: "dxv",
			fps: 25,
			mode: "loop",
			holdMs: 0,
			cycleMs: 0,
		});
		let loop = looped.job;
		for (let i = 0; i < 400 && loop.state === "running"; i++) {
			await sleep(300);
			loop = (await api("GET", `${RENDER}/jobs/${loop.id}`)).json.job;
		}
		check(
			"loop: one cycle of both loops, found by itself",
			loop.state === "done" && loop.cycleMs === 3000 && loop.frames === 75 && (loop.missMs ?? 0) < 1,
			JSON.stringify({ state: loop.state, error: loop.error, cycleMs: loop.cycleMs, frames: loop.frames, missMs: loop.missMs }),
		);
		if (loop.state === "done" && hasFfmpeg) {
			const response = await fetch(`${BASE}${RENDER}/files/${encodeURIComponent(loop.file)}`);
			const file = path.join(outDir, loop.file);
			fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
			// Round the corner, from the last frame to the first, no part jumps
			// further than it moves from one frame to the next.
			const seam = (values) => {
				const steps = values.map((value, i) => Math.abs(value - values[(i + 1) % values.length]));
				return { wrap: steps[steps.length - 1], most: Math.max(...steps.slice(0, -1)) };
			};
			const left = seam(alphaAt(file, "dxv", 320, 180, 80, 90));
			const right = seam(alphaAt(file, "dxv", 320, 180, 240, 90));
			check(
				"loop: the last frame leads into the first",
				left.wrap <= left.most + 4 && right.wrap <= right.most + 4 && left.most > 0 && right.most > 0,
				JSON.stringify({ left, right }),
			);
		}

		// --- 3. one at a time, and a stop ----------------------------------
		const { json: long } = await api("POST", `${RENDER}/jobs`, {
			templateId: "e2e-render-code",
			format: "dxv",
			fps: 25,
			holdMs: 60_000,
		});
		const second = await api(
			"POST",
			`${RENDER}/jobs`,
			{ templateId: "e2e-render-code", format: "dxv", fps: 25, holdMs: 1000 },
			[409],
		);
		check("a second render while one runs is refused", second.status === 409, `${second.status}`);
		await sleep(1500);
		await api("DELETE", `${RENDER}/jobs/${long.job.id}`);
		let stopped = long.job;
		for (let i = 0; i < 50 && stopped.state === "running"; i++) {
			await sleep(200);
			stopped = (await api("GET", `${RENDER}/jobs/${long.job.id}`)).json.job;
		}
		check("a render can be stopped", stopped.state === "cancelled" && !stopped.file, stopped.state);
	} finally {
		await api("DELETE", "/api/templates/e2e-render-code", undefined, [404]);
		await api("DELETE", "/api/templates/e2e-render-layers", undefined, [404]);
		await api("DELETE", "/api/templates/e2e-render-loop", undefined, [404]);
	}

	console.log(
		`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`,
	);
	console.log(`files: ${outDir}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("E2E ERROR:", error);
	process.exit(2);
});
