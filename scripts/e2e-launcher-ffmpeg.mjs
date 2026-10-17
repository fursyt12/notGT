#!/usr/bin/env node
/**
 * End-to-end test of the launcher's «Install ffmpeg» (launcher/index.mjs).
 *
 * Uses Node builtins + global fetch only, and no network: it writes a small
 * zip laid out like BtbN's Windows builds (`<top>/bin/ffmpeg.exe`, …), serves
 * it on 127.0.0.1 and points the launcher at it with NOTGT_FFMPEG_URL. PATH is
 * emptied for the launcher so that an ffmpeg of the system does not count.
 *
 *   1. With no ffmpeg the state offers the install.
 *   2. A request that is not JSON is refused (415).
 *   3. One POST starts it (202); the state reaches "installed", `bin/` is
 *      unpacked flat without ffplay, the licence and notgt-ffmpeg.json are
 *      there, and nothing is left next to the folder.
 *   4. Pressed again, it answers that ffmpeg is installed (200).
 *   5. A wrong checksum ends in `failed`, offers the install again and leaves
 *      no folder behind.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const launcherPath = path.join(repoRoot, "launcher", "index.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-ffmpeg-"));

const checks = [];
function check(name, ok, detail = "") {
	checks.push({ name, ok: !!ok });
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`,
	);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A zip of `files` ({ name: Buffer }), deflated, with a central directory. */
function makeZip(files) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const [name, data] of Object.entries(files)) {
		const packed = zlib.deflateRawSync(data);
		const nameBuf = Buffer.from(name, "utf8");
		const crc = zlib.crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, packed);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBuf.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBuf);
		offset += local.length + nameBuf.length + packed.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

const top = "ffmpeg-n9.9-latest-win64-lgpl-shared-9.9";
const payload = {
	[`${top}/`]: Buffer.alloc(0),
	[`${top}/bin/`]: Buffer.alloc(0),
	[`${top}/bin/ffmpeg.exe`]: crypto.randomBytes(200_000),
	[`${top}/bin/ffprobe.exe`]: crypto.randomBytes(50_000),
	[`${top}/bin/ffplay.exe`]: crypto.randomBytes(1_000),
	[`${top}/bin/avcodec-63.dll`]: Buffer.alloc(300_000, 7),
	[`${top}/LICENSE.txt`]: Buffer.from("GNU LESSER GENERAL PUBLIC LICENSE\n"),
	[`${top}/include/libavcodec/avcodec.h`]: Buffer.from("/* not wanted */\n"),
};
const zip = makeZip(payload);
const sha256 = crypto.createHash("sha256").update(zip).digest("hex");

const server = http.createServer((req, res) => {
	res.writeHead(200, {
		"Content-Length": zip.length,
		"Content-Type": "application/zip",
	});
	res.end(zip);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const zipUrl = `http://127.0.0.1:${server.address().port}/${top}.zip`;

/** Starts a launcher that installs into `dir`; resolves with its control URL. */
function startLauncher(dir, checksum) {
	const child = spawn(
		process.execPath,
		[
			launcherPath,
			"--app",
			tmp,
			"--control-port",
			"0",
			"--no-open",
			"--no-ndi",
			"--settings",
			path.join(tmp, "settings.json"),
			"--runtime",
			path.join(tmp, `runtime-${path.basename(dir)}.json`),
			"--lang",
			"en",
		],
		{
			cwd: tmp,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				PATH: path.join(tmp, "no-such-dir"),
				Path: path.join(tmp, "no-such-dir"),
				NOTGT_FFMPEG_DIR: dir,
				NOTGT_FFMPEG_URL: zipUrl,
				NOTGT_FFMPEG_SHA256: checksum,
			},
		},
	);
	let out = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 15_000;
		const poll = () => {
			const match = out.match(/notGT launcher on (http:\/\/127\.0\.0\.1:\d+)/);
			if (match) resolve({ child, url: match[1] });
			else if (Date.now() > deadline)
				reject(new Error(`no control URL: ${out}`));
			else setTimeout(poll, 100);
		};
		poll();
	});
}

async function ffmpegState(url) {
	const res = await fetch(`${url}/api/state`);
	return (await res.json()).ffmpeg;
}

async function install(url, contentType = "application/json") {
	const res = await fetch(`${url}/api/ffmpeg/install`, {
		method: "POST",
		headers: { "Content-Type": contentType },
		body: "{}",
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitSettled(url) {
	for (let i = 0; i < 100; i++) {
		const info = await ffmpegState(url);
		if (!info.installing) return info;
		await sleep(100);
	}
	return ffmpegState(url);
}

const launchers = [];
try {
	// --- a good archive
	const dir = path.join(tmp, "ffmpeg");
	const good = await startLauncher(dir, sha256);
	launchers.push(good.child);
	const before = await ffmpegState(good.url);
	check(
		"with no ffmpeg the state offers the install",
		before && !before.installed && before.canInstall,
		JSON.stringify(before),
	);
	check(
		"…and says what is missing",
		/not installed/.test(before?.text ?? ""),
		before?.text,
	);

	const plain = await install(good.url, "text/plain");
	check(
		"a request that is not JSON is refused",
		plain.status === 415,
		String(plain.status),
	);

	const started = await install(good.url);
	check(
		"one press starts the install",
		started.status === 202 && started.body.ffmpeg?.installing,
		JSON.stringify(started),
	);

	const after = await waitSettled(good.url);
	check(
		"…and it ends installed, by the launcher",
		after.installed && after.source === "launcher" && !after.canInstall,
		JSON.stringify(after),
	);
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
	check(
		"bin/ is unpacked flat, without ffplay, with the licence",
		JSON.stringify(files) ===
			JSON.stringify([
				"LICENSE.txt",
				"avcodec-63.dll",
				"ffmpeg.exe",
				"ffprobe.exe",
				"notgt-ffmpeg.json",
			]),
		JSON.stringify(files),
	);
	check(
		"…byte for byte",
		files.includes("ffmpeg.exe") &&
			fs
				.readFileSync(path.join(dir, "ffmpeg.exe"))
				.equals(payload[`${top}/bin/ffmpeg.exe`]),
	);
	const meta = files.includes("notgt-ffmpeg.json")
		? JSON.parse(fs.readFileSync(path.join(dir, "notgt-ffmpeg.json"), "utf8"))
		: {};
	check(
		"notgt-ffmpeg.json records the archive and its checksum",
		meta.sha256 === sha256 && meta.asset === `${top}.zip`,
		JSON.stringify(meta),
	);
	check(
		"nothing is left next to the folder",
		!fs.existsSync(`${dir}.new`) && !fs.existsSync(`${dir}.download.zip`),
	);
	const again = await install(good.url);
	check(
		"pressed again, it answers that ffmpeg is there",
		again.status === 200 && again.body.ffmpeg?.installed,
		JSON.stringify(again),
	);

	// --- a corrupt download
	const badDir = path.join(tmp, "ffmpeg-bad");
	const bad = await startLauncher(badDir, "0".repeat(64));
	launchers.push(bad.child);
	const badStart = await install(bad.url);
	const badEnd = await waitSettled(bad.url);
	check(
		"a wrong checksum ends in failed and offers the install again",
		badStart.status === 202 &&
			badEnd.failed &&
			!badEnd.installed &&
			badEnd.canInstall &&
			/checksum/.test(badEnd.text),
		JSON.stringify(badEnd),
	);
	check(
		"…leaving no folder behind",
		!fs.existsSync(badDir) &&
			!fs.existsSync(`${badDir}.new`) &&
			!fs.existsSync(`${badDir}.download.zip`),
	);
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err));
} finally {
	for (const child of launchers) child.kill();
	server.close();
	await sleep(300);
	fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.log(
	failed
		? `\n${failed} of ${checks.length} checks failed`
		: `\nAll ${checks.length} ffmpeg install checks passed`,
);
process.exit(failed ? 1 : 0);
