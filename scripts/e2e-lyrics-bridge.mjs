#!/usr/bin/env node
/**
 * End-to-end test of notGT Lyrics Bridge (lyrics-bridge/win/notGT-lyrics-bridge.c) without
 * Windows: the program is cross-compiled with mingw-w64 and run under wine in
 * a virtual display, against a stand-in for notGT's WebSocket API that records
 * every frame. Nothing here reaches the internet: the demo song is built in,
 * and the track with several variants comes from a cache file written here.
 *
 * What it checks:
 *   1. the program builds without warnings;
 *   2. it connects, reads notGT's hello, and sends the lines of the demo song
 *      in order as `karaoke.*` frames; its windows are drawn in the brand colours;
 *   3. from a remembered track it shows the best variant, and the buttons
 *      switch to another variant and shift the text — remembered for the track;
 *   4. a track nobody remembered gets LRCLIB's first answer at once while its
 *      other requests hang, as they do on networks that freeze connections to
 *      Cloudflare; an answer frozen half-way ends after a pause and gives the
 *      songs that came whole (a stand-in for LRCLIB and NetEase, --sources);
 *   5. with no key notGT asks for one; a key typed in and "Connect" gets in,
 *      and the key is stored encrypted, not as text;
 *   6. closing the window hides it and the program goes on; "Quit" in the
 *      tray menu tells the title that nothing plays and ends the program.
 *
 * Needs: x86_64-w64-mingw32-gcc + windres, wine, Xvfb (xvfb-run), xdotool.
 * Without them it says so and exits 0 — this is a developer's test, not a
 * gate. It shares the wine prefix of the launcher's test (NOTGT_WINEPREFIX).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), "..");
const win = path.join(repo, "lyrics-bridge", "win");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const failures = [];
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(name);
}

const missing = ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-windres", "wine", "xvfb-run", "xdotool"].filter(
	(cmd) => !has(cmd),
);
if (missing.length > 0) {
	console.log(`SKIP  the lyrics bridge test needs: ${missing.join(", ")}`);
	process.exit(0);
}

// Everything below draws windows: do it on a display of our own.
if (!process.env.NOTGT_E2E_XVFB) {
	const result = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1400x1000x24", process.execPath, self], {
		stdio: ["ignore", "inherit", "ignore"],
		env: { ...process.env, NOTGT_E2E_XVFB: "1" },
	});
	process.exit(result.status ?? 1);
}

const { WebSocketServer } = createRequire(path.join(repo, "package.json"))("ws");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-lyrics-bridge-"));
const exe = path.join(tmp, "notgt-lyrics-bridge.exe");
const post = path.join(tmp, "post.exe");
const wineEnv = {
	...process.env,
	WINEPREFIX: process.env.NOTGT_WINEPREFIX ?? path.join(os.tmpdir(), "notgt-wine-prefix"),
	WINEDEBUG: "-all",
	WINEDLLOVERRIDES: "mscoree,mshtml=",
};
/** A host path as wine sees it. */
const winPath = (p) => `Z:${p.replaceAll("/", "\\")}`;
const xdo = (...args) => spawnSync("xdotool", args, { encoding: "utf8" }).stdout.trim();

async function waitFor(what, test, timeoutMs = 20_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await test();
		if (value) return value;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The colour of a pixel of a 24-bit .bmp, as "rrggbb"; (x, y) from the top left. */
function pixel(file, x, y) {
	const data = fs.readFileSync(file);
	const offset = data.readUInt32LE(10);
	const width = data.readInt32LE(18);
	const height = data.readInt32LE(22);
	const at = offset + (height - 1 - y) * ((width * 3 + 3) & ~3) + x * 3;
	return [data[at + 2], data[at + 1], data[at]].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * A stand-in for notGT's WebSocket API: the hello, the key check as notGT
 * makes it (no key: a hello saying so, then the door; a wrong key: the door),
 * a reply to every frame, and a record of what came.
 */
async function fakeNotgt(key = "") {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve) => wss.once("listening", resolve));
	const record = { tokens: [], frames: [] };
	wss.on("connection", (socket, req) => {
		const token = new URL(req.url, "http://localhost").searchParams.get("token") ?? "";
		record.tokens.push(token);
		const hello = (authenticated) =>
			JSON.stringify({ type: "hello", protocol: 1, version: "e2e", authRequired: Boolean(key), authenticated });
		if (key && !token) {
			socket.send(hello(false));
			setTimeout(() => {
				socket.send(JSON.stringify({ type: "error", code: "unauthorized", message: "No login frame" }));
				socket.close(4401, "unauthorized");
			}, 1000);
			return;
		}
		if (key && token !== key) {
			socket.send(JSON.stringify({ type: "error", code: "unauthorized", message: "Wrong key" }));
			socket.close(4401, "unauthorized");
			return;
		}
		socket.send(hello(true));
		socket.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			record.frames.push(frame);
			socket.send(JSON.stringify({ type: "reply", id: frame.id, command: frame.type, ok: true }));
		});
	});
	return { port: wss.address().port, record, close: () => wss.close() };
}

/** The karaoke variables of every frame, in order. */
const karaoke = (record) => record.frames.filter((f) => f.type === "setData").map((f) => f.data.karaoke);

/** Starts the program; `exited` resolves when it ends. */
function start(args) {
	const child = spawn("wine", [exe, ...args], { env: wineEnv, stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
	return { child, exited };
}

function settings(file, values) {
	fs.writeFileSync(file, JSON.stringify(values));
	return winPath(file);
}

/** The cache file of a track: FNV-1a 64 of "artist|title|seconds", as cache_path() makes it. */
function cacheFile(dir, artist, title, seconds) {
	let h = 0xcbf29ce484222325n;
	for (const unit of `${artist}|${title}|${seconds}`.split("").map((c) => c.charCodeAt(0))) {
		h = ((h ^ BigInt(unit)) * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return path.join(dir, `${h.toString(16).padStart(16, "0")}.json`);
}

const journal = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** The X window of the main window (480x618 at 96 dpi). */
function mainWindow() {
	for (const id of xdo("search", "--name", "notGT").split("\n").filter(Boolean)) {
		if (xdo("getwindowgeometry", id).includes("480x618")) return id;
	}
	return "";
}

async function main() {
	// ------------------------------------------------------------------ build
	const res = spawnSync("x86_64-w64-mingw32-windres", ["notGT-lyrics-bridge.rc", "-O", "coff", "-o", path.join(tmp, "res.o")], {
		cwd: win,
		encoding: "utf8",
	});
	const cc = spawnSync(
		"x86_64-w64-mingw32-gcc",
		[
			"-Wall",
			"-Wextra",
			"-O2",
			"-municode",
			"-mwindows",
			"-o",
			exe,
			"notGT-lyrics-bridge.c",
			path.join(tmp, "res.o"),
			"-lwinhttp",
			"-lgdiplus",
			"-lole32",
			"-lshell32",
			"-lgdi32",
			"-lcomctl32",
			"-lcrypt32",
		],
		{ cwd: win, encoding: "utf8" },
	);
	check("the lyrics bridge compiles", res.status === 0 && cc.status === 0, res.stderr + cc.stderr);
	check("…without warnings", (res.stderr + cc.stderr).trim() === "", res.stderr + cc.stderr);
	const helper = spawnSync("x86_64-w64-mingw32-gcc", ["-O2", "-municode", "-o", post, "test/post.c"], { cwd: win, encoding: "utf8" });
	if (cc.status !== 0 || helper.status !== 0) return;

	const cache = path.join(tmp, "cache");
	fs.mkdirSync(cache);
	try {
		// ---------------------------------------------- the demo song, the look
		{
			const notgt = await fakeNotgt();
			const log = path.join(tmp, "demo.log");
			const shots = path.join(tmp, "shots");
			fs.mkdirSync(shots);
			const run = start([
				"--simulate",
				"--settings",
				settings(path.join(tmp, "demo.json"), { address: `127.0.0.1:${notgt.port}`, lang: "en" }),
				"--cache",
				winPath(cache),
				"--log-file",
				winPath(log),
				"--snapshot",
				winPath(shots),
				"--snapshot-after",
				"9",
			]);
			await run.exited;
			notgt.close();
			const lines = karaoke(notgt.record).map((k) => k.cur);
			const heard = [...new Set(lines.filter(Boolean))];
			check("it reads notGT's hello", journal(log).includes("notGT: connected (notGT e2e)"), journal(log));
			check(
				"the demo song's lines arrive in order",
				heard.slice(0, 3).join(" / ") === "This is the karaoke demo / Lines change on their timecodes / And the fill runs left to right",
				heard.join(" / "),
			);
			const last = karaoke(notgt.record).at(-2) ?? {};
			check(
				"…with the track, the next line and the timing",
				last.artist === "Demo" && last.title === "Karaoke test" && Number(last.dur) > 0 && last.playing === "1",
				JSON.stringify(last),
			);
			const seqs = karaoke(notgt.record).map((k) => Number(k.seq));
			check("…every frame with a new seq", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(","));
			const main = path.join(shots, "main.bmp");
			check(
				"the windows are drawn",
				["main", "musixmatch", "journal"].every((name) => fs.existsSync(path.join(shots, `${name}.bmp`))),
			);
			check("…on the Studio ground", fs.existsSync(main) && pixel(main, 4, 4) === "0c2b25", fs.existsSync(main) ? pixel(main, 4, 4) : "");
			check("…with Lemon for a live connection", fs.existsSync(main) && pixel(main, 48, 170) === "ffd23f", fs.existsSync(main) ? pixel(main, 48, 170) : "");
		}

		// ------------------------------------------- variants and the shift
		{
			const notgt = await fakeNotgt();
			const log = path.join(tmp, "variants.log");
			const remembered = cacheFile(cache, "E2E Artist", "E2E Song", 60);
			const lines = (letter) => Array.from({ length: 30 }, (_, i) => [i * 2000, `${letter}${i + 1} line`, null]);
			fs.writeFileSync(
				remembered,
				JSON.stringify({
					variants: [
						{ id: "", sources: "lrclib", artist: "E2E Artist", votes: 3, lyrics: lines("A") },
						{ id: "", sources: "netease", artist: "E2E Artist feat. Second Voice", votes: 1, lyrics: lines("B") },
					],
					// Spotify reports only the first artist. The fullest credit may come
					// from a song a source matched without lyrics.
					credit: "Second Voice & E2E Artist feat. Third",
					pick: "",
					manual: false,
					offset: 0,
				}),
			);
			const run = start([
				"--fake",
				"E2E Artist|E2E Song|60|0",
				"--settings",
				settings(path.join(tmp, "variants.json"), { address: `127.0.0.1:${notgt.port}`, lang: "en" }),
				"--cache",
				winPath(cache),
				"--log-file",
				winPath(log),
				"--command",
				"n@4",
				"--command",
				"+@5",
				"--command",
				"+@5.5",
			]);
			await waitFor("the shift", () => journal(log).includes("offset for this track: +200 ms"), 30_000);
			await sleep(1000);
			spawnSync("wine", [post, "quit"], { env: wineEnv });
			await run.exited;
			notgt.close();
			const shown = karaoke(notgt.record).map((k) => k.cur).filter(Boolean);
			check("a remembered track starts with its best variant", shown[0]?.startsWith("A"), shown.join(" / "));
			check("\"Next\" switches to the other variant", shown.at(-1)?.startsWith("B"), shown.join(" / "));
			const artists = karaoke(notgt.record).map((k) => k.artist).filter(Boolean);
			check(
				"every artist a source credits reaches the title, the reported one first",
				artists.at(-1) === "E2E Artist, Second Voice, Third",
				[...new Set(artists)].join(" / "),
			);
			const saved = JSON.parse(fs.readFileSync(remembered, "utf8"));
			const second = saved.variants.find((v) => v.sources === "netease");
			check(
				"the choice and the shift are remembered for the track",
				saved.manual === true && saved.offset === 200 && second && saved.pick === second.id,
				JSON.stringify({ manual: saved.manual, offset: saved.offset, pick: saved.pick }),
			);
		}

		// ------------------------------------ a lookup through frozen connections
		{
			// get-cached answers at once; every search sends two songs and a half and
			// then nothing, for good; NetEase has nothing.
			const entry = (id, letter) => ({
				id,
				artistName: "E2E Frozen",
				trackName: "E2E Search",
				duration: 60,
				syncedLyrics: Array.from({ length: 20 }, (_, i) => `[00:${String(i * 2).padStart(2, "0")}.00] ${letter}${i + 1} line`).join("\n"),
			});
			const list = JSON.stringify([entry(2, "B"), entry(3, "C"), entry(4, "D")]);
			const hanging = [];
			const sources = http.createServer((req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				if (req.url.startsWith("/lrclib/api/get-cached")) res.end(JSON.stringify(entry(1, "A")));
				else if (req.url.startsWith("/lrclib/api/search")) hanging.push(res.write(list.slice(0, list.indexOf('{"id":4') + 40)) && res);
				else res.end(JSON.stringify({ result: { songs: [] } }));
			});
			await new Promise((resolve) => sources.listen(0, "127.0.0.1", resolve));
			const notgt = await fakeNotgt();
			const log = path.join(tmp, "frozen.log");
			const run = start([
				"--fake",
				"E2E Frozen|E2E Search|60|0",
				"--sources",
				`http://127.0.0.1:${sources.address().port}`,
				"--settings",
				settings(path.join(tmp, "frozen.json"), { address: `127.0.0.1:${notgt.port}`, lang: "en" }),
				"--cache",
				winPath(cache),
				"--log-file",
				winPath(log),
			]);
			await waitFor("the end of the lookup", () => /lrclib: \d+ variants? in|lrclib failed/.test(journal(log)), 30_000);
			spawnSync("wine", [post, "quit"], { env: wineEnv });
			await run.exited;
			notgt.close();
			for (const res of hanging) res.destroy();
			sources.close();
			const text = journal(log);
			const early = /lrclib: 1 variant so far in ([\d.]+) s/.exec(text);
			const shown = text.indexOf("lyrics: 20 lines [lrclib]");
			const stopped = text.indexOf("lrclib: 3 of 6 answers stopped half-way");
			const ended = /lrclib: (\d+) variants? in ([\d.]+) s/.exec(text);
			check(
				"a track nobody remembered gets LRCLIB's first answer while its searches hang",
				Boolean(early) && Number(early[1]) < 1 && shown >= 0 && stopped > shown,
				text,
			);
			check("an answer frozen half-way gives the songs that came whole", stopped >= 0 && ended?.[1] === "3", text);
			check("…and ends after a pause, not the timeout", Number(ended?.[2]) < 3.5, ended?.[0] ?? text);
		}

		// ---------------------------------------------------------- the key
		{
			const notgt = await fakeNotgt("e2e-secret");
			const log = path.join(tmp, "key.log");
			const file = path.join(tmp, "key.json");
			const run = start([
				"--simulate",
				"--settings",
				settings(file, { address: `127.0.0.1:${notgt.port}`, lang: "en" }),
				"--cache",
				winPath(cache),
				"--log-file",
				winPath(log),
			]);
			await waitFor("the request for a key", () => journal(log).includes("notGT: a key is needed"));
			const id = await waitFor("the main window", mainWindow);
			xdo("mousemove", "--window", id, "330", "126", "click", "1");
			await sleep(300);
			xdo("type", "--delay", "40", "e2e-secret");
			await sleep(300);
			xdo("mousemove", "--window", id, "390", "171", "click", "1");
			await waitFor("the connection", () => journal(log).includes("notGT: connected"));
			check("with no key, notGT's request for one is shown", true);
			check("a key typed in and \"Connect\" get in", notgt.record.tokens.at(-1) === "e2e-secret", notgt.record.tokens.join(","));
			const stored = fs.readFileSync(file, "utf8");
			check(
				"the key is stored encrypted, not as text",
				!stored.includes("e2e-secret") && JSON.parse(stored).key.length > 20,
				stored,
			);

			// -------------------------------------------- hiding and quitting
			spawnSync("wine", [post, "close"], { env: wineEnv });
			await sleep(1000);
			const visible = spawnSync("wine", [post, "visible"], { env: wineEnv }).status;
			check("closing the window hides it", visible === 2, `post visible: ${visible}`);
			check("…and the program goes on", run.child.exitCode === null);
			spawnSync("wine", [post, "quit"], { env: wineEnv });
			const ended = await Promise.race([run.exited, sleep(10_000).then(() => false)]);
			notgt.close();
			check("\"Quit\" ends it", ended === true);
			const last = karaoke(notgt.record).at(-1) ?? {};
			check("…telling the title that nothing plays", last.playing === "0" && last.cur === "", JSON.stringify(last));
		}
	} finally {
		spawnSync("wineserver", ["-k"], { env: wineEnv });
	}
}

main()
	.catch((error) => check("no unexpected error", false, error.stack ?? String(error)))
	.finally(() => {
		if (failures.length === 0) fs.rmSync(tmp, { recursive: true, force: true });
		else console.log(`\nleft for inspection: ${tmp}`);
		console.log(failures.length === 0 ? "\nAll lyrics bridge checks passed" : `\n${failures.length} check(s) failed`);
		process.exit(failures.length === 0 ? 0 : 1);
	});
