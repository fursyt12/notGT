#!/usr/bin/env node
/**
 * notGT render test: an animation rendered to a video file with alpha.
 *
 *   1. a code animation with a known fade is rendered in every format the
 *      server can make (WebM VP9, ProRes 4444, DXV3); each file has the codec,
 *      the frame count and, frame by frame, the alpha the fade gives;
 *   2. a `layers` animation (CSS transitions) comes out whole: transparent at
 *      the start and the end, opaque in the middle;
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
