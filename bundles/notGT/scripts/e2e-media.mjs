#!/usr/bin/env node
/**
 * notGT media-upload smoke test.
 *
 * Exercises the server half of the editor's drag-and-drop flow:
 *   - a ProRes 4444 `.mov` with alpha is uploaded, converted server-side and
 *     published with its alpha intact,
 *   - a browser-ready `.webm` is published as-is (no conversion),
 *   - the public list reflects both, the files are actually served, and a
 *     path-traversal delete is rejected.
 *
 * Needs ffmpeg on PATH to build the fixtures (the same requirement the server
 * has for converting). Without it the suite reports SKIPPED and exits 0.
 *
 * Usage (server must be running on 127.0.0.1:9090):
 *   node scripts/e2e-media.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", ".e2e", "media-fixtures");
const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const MEDIA = `${BASE}/bundles/notGT/media`;

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

function ffmpegAvailable() {
	return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

function ffmpeg(args) {
	const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
		encoding: "utf8",
	});
	if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
}

/** Alpha plane stats of the first frame, read from raw RGBA bytes. */
function alphaStats(file) {
	const res = spawnSync(
		"ffmpeg",
		["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
		{ maxBuffer: 1 << 28 },
	);
	if (res.status !== 0 || !res.stdout?.length) return undefined;
	const data = res.stdout;
	let min = 255;
	let max = 0;
	for (let i = 3; i < data.length; i += 4) {
		const a = data[i];
		if (a < min) min = a;
		if (a > max) max = a;
	}
	return { min, max };
}

async function upload(name, file, kind) {
	const body = fs.readFileSync(file);
	const query = `name=${encodeURIComponent(name)}${kind ? `&kind=${kind}` : ""}`;
	const response = await fetch(`${MEDIA}/upload?${query}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { error: text.slice(0, 200) };
	}
	if (!response.ok || !json.jobId) {
		throw new Error(`upload ${name} -> ${response.status}: ${text.slice(0, 300)}`);
	}
	return { jobId: json.jobId, bytes: json.bytes };
}

async function waitForJob(jobId, timeoutMs = 90_000) {
	const started = Date.now();
	let job;
	while (Date.now() - started < timeoutMs) {
		const response = await fetch(`${MEDIA}/jobs/${jobId}`);
		if (!response.ok) throw new Error(`job ${jobId} -> HTTP ${response.status}`);
		job = (await response.json()).job;
		if (job.state === "done" || job.state === "error") return job;
		await sleep(400);
	}
	throw new Error(`job ${jobId} did not finish: ${JSON.stringify(job)}`);
}

async function remove(name) {
	await fetch(`${MEDIA}/file/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
}

async function main() {
	if (!ffmpegAvailable()) {
		console.log("SKIPPED  ffmpeg is not available, cannot build fixtures");
		console.log("\nALL CHECKS PASSED (skipped)");
		return;
	}
	fs.mkdirSync(fixtures, { recursive: true });

	// A small alpha clip in a format no browser can play.
	const mov = path.join(fixtures, "e2e-alpha.mov");
	ffmpeg([
		"-f", "lavfi", "-i", "color=c=black:s=640x360:d=2:r=25",
		"-vf", "format=rgba,geq=r='255':g='59':b='48':a='255*lt(abs(X-320-200*abs(sin(T*1.5))),60)*lt(abs(Y-180),60)'",
		"-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-an", mov,
	]);
	const webm = path.join(fixtures, "e2e-ready.webm");
	ffmpeg([
		"-f", "lavfi", "-i", "color=c=black:s=320x180:d=1:r=25",
		"-vf", "format=rgba,geq=r='255':g='200':b='0':a='255*lt(abs(X-160),50)*lt(abs(Y-90),50)'",
		"-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
		"-b:v", "0", "-crf", "40", "-cpu-used", "4", "-an", webm,
	]);

	const created = [];

	try {
		// --- 1. heavy alpha .mov goes through the converter ---------------
		const heavy = await upload("E2E Тяжёлый Ролик.mov", mov);
		check("upload accepts a heavy .mov", heavy.bytes > 0, `${heavy.bytes} bytes`);
		const converted = await waitForJob(heavy.jobId);
		check(
			"server converts the .mov",
			converted.state === "done",
			`${converted.state}${converted.error ? `: ${converted.error}` : ""}`,
		);
		check(
			"converted file is webp/webm with a served url",
			!!converted.src && /\.(webp|webm)$/.test(converted.src),
			`${converted.src} (${converted.format})`,
		);
		const convertedName = decodeURIComponent(converted.src.split("/").pop());
		created.push(convertedName);

		const served = await fetch(`${BASE}${converted.src}`);
		check("converted file is served", served.status === 200, `HTTP ${served.status}`);
		const servedFile = path.join(fixtures, "served");
		fs.writeFileSync(servedFile, Buffer.from(await served.arrayBuffer()));
		const alpha = alphaStats(servedFile);
		check(
			"converted file kept its alpha",
			!!alpha && alpha.min === 0 && alpha.max === 255,
			JSON.stringify(alpha),
		);
		check(
			"converted file is smaller than the source",
			(converted.bytes ?? 0) > 0 && (converted.bytes ?? 0) < (converted.inputBytes ?? Infinity),
			`${converted.inputBytes} -> ${converted.bytes}`,
		);

		// --- 1b. a short clip dropped into a VIDEO layer must be WebM ----
		// A <video> cannot play animated WebP, so the video drop zone asks for
		// `kind=video` and the server must skip its usual short-clip WebP choice.
		const forVideo = await upload("E2E Для Видео.mov", mov, "video");
		const videoJob = await waitForJob(forVideo.jobId);
		check(
			"kind=video forces a WebM (a <video> cannot play WebP)",
			videoJob.state === "done" && /\.webm$/.test(videoJob.src ?? ""),
			`${videoJob.state} / ${videoJob.src} (${videoJob.format})`,
		);
		created.push(decodeURIComponent((videoJob.src ?? "").split("/").pop()));

		const videoServed = await fetch(`${BASE}${videoJob.src}`);
		check("video-layer file is served", videoServed.status === 200, `HTTP ${videoServed.status}`);

		// --- 2. a browser-ready file is published as-is -------------------
		const ready = await upload("e2e-ready.webm", webm);
		const published = await waitForJob(ready.jobId);
		check(
			"browser-ready .webm is published without conversion",
			published.state === "done" && published.format === "webm",
			`${published.state} / ${published.format}`,
		);
		created.push(decodeURIComponent(published.src.split("/").pop()));

		// --- 3. listing + deletion ----------------------------------------
		const list = await (await fetch(`${MEDIA}/list`)).json();
		check(
			"list exposes the uploaded files",
			created.every((name) =>
				list.files.some((entry) => entry.name === name || entry.name.startsWith(name.replace(/\.[^.]+$/, ""))),
			),
			created.join(", "),
		);

		const traversal = await fetch(`${MEDIA}/file/${encodeURIComponent("../../nodecg.json")}`, {
			method: "DELETE",
		});
		check(
			"delete refuses path traversal",
			traversal.status === 404 || traversal.status === 400,
			`HTTP ${traversal.status}`,
		);

		const removed = await fetch(`${MEDIA}/file/${encodeURIComponent(created[1])}`, {
			method: "DELETE",
		});
		check("stored file can be deleted", removed.status === 200, `HTTP ${removed.status}`);
	} finally {
		for (const name of created) await remove(name);
		fs.rmSync(fixtures, { recursive: true, force: true });
	}

	console.log(
		`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`,
	);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("E2E ERROR:", error);
	process.exit(2);
});
