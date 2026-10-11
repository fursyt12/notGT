#!/usr/bin/env node
/**
 * End-to-end test of the launcher's window (launcher/win/notGT-launcher.c)
 * without Windows: the program is cross-compiled with mingw-w64 and run under
 * wine in a virtual display, against the real `launcher/index.mjs` running on
 * the host.
 *
 * What it checks:
 *   1. the program builds without warnings;
 *   2. started the way a user starts it, it launches its Node process, reads
 *      the banner and draws its four windows in the brand colours;
 *   3. the RU / EN switch changes the language of the window and of what the
 *      backend says, and the choice is remembered;
 *   4. a name and a password typed into the sign-in window end up in
 *      cfg/nodecg.json, the password as the HMAC NodeCG expects;
 *   5. closing the window with the server running leaves the server running;
 *      started again, the program finds the launcher that stayed behind and
 *      shows the server as running;
 *   6. closing it with the server stopped ends the launcher's process too.
 *
 * Needs: x86_64-w64-mingw32-gcc + windres, wine, Xvfb (xvfb-run), xdotool.
 * Without them it says so and exits 0 — this is a developer's test, not a
 * gate. The first run creates a wine prefix (NOTGT_WINEPREFIX, by default in
 * the system's temp directory), which takes a while.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), "..");
const win = path.join(repo, "launcher", "win");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const failures = [];
function check(name, ok, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`,
	);
	if (!ok) failures.push(name);
}

const missing = [
	"x86_64-w64-mingw32-gcc",
	"x86_64-w64-mingw32-windres",
	"wine",
	"xvfb-run",
	"xdotool",
].filter((cmd) => !has(cmd));
if (missing.length > 0) {
	console.log(`SKIP  the launcher window test needs: ${missing.join(", ")}`);
	process.exit(0);
}

// Everything below draws windows: do it on a display of our own.
if (!process.env.NOTGT_E2E_XVFB) {
	const result = spawnSync(
		"xvfb-run",
		["-a", "-s", "-screen 0 1400x1000x24", process.execPath, self],
		{
			stdio: ["ignore", "inherit", "ignore"],
			env: { ...process.env, NOTGT_E2E_XVFB: "1" },
		},
	);
	process.exit(result.status ?? 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-launcher-"));
const pkg = path.join(tmp, "notGT-win-x64");
const appDir = path.join(tmp, "app");
const shots = path.join(tmp, "shots");
const heartbeat = path.join(tmp, "heartbeat");
const wineEnv = {
	...process.env,
	WINEPREFIX:
		process.env.NOTGT_WINEPREFIX ?? path.join(os.tmpdir(), "notgt-wine-prefix"),
	WINEDEBUG: "-all",
	WINEDLLOVERRIDES: "mscoree,mshtml=",
};
/** A host path as wine sees it. */
const winPath = (p) => `Z:${p.replaceAll("/", "\\")}`;
const xdo = (...args) =>
	spawnSync("xdotool", args, { encoding: "utf8" }).stdout.trim();

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** The colour of a pixel of a 24-bit .bmp, as "rrggbb"; (x, y) from the top left. */
function pixel(file, x, y) {
	const data = fs.readFileSync(file);
	const offset = data.readUInt32LE(10);
	const width = data.readInt32LE(18);
	const height = data.readInt32LE(22);
	const at = offset + (height - 1 - y) * ((width * 3 + 3) & ~3) + x * 3;
	return [data[at + 2], data[at + 1], data[at]]
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("");
}

async function waitFor(what, test, timeoutMs = 15_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const value = await test();
		if (value) return value;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function main() {
	// ------------------------------------------------------------------ build
	for (const dir of [
		pkg,
		path.join(pkg, "node"),
		path.join(pkg, "launcher"),
		path.join(pkg, "app"),
		appDir,
		shots,
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const exe = path.join(pkg, "notGT Launcher.exe");
	const res = spawnSync(
		"x86_64-w64-mingw32-windres",
		["notGT-launcher.rc", "-O", "coff", "-o", path.join(tmp, "res.o")],
		{ cwd: win, encoding: "utf8" },
	);
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
			"notGT-launcher.c",
			path.join(tmp, "res.o"),
			"-lwinhttp",
			"-lgdiplus",
			"-lole32",
			"-lshell32",
			"-lgdi32",
			"-lcomctl32",
		],
		{ cwd: win, encoding: "utf8" },
	);
	check(
		"the launcher compiles",
		res.status === 0 && cc.status === 0,
		res.stderr + cc.stderr,
	);
	check(
		"…without warnings",
		(res.stderr + cc.stderr).trim() === "",
		res.stderr + cc.stderr,
	);
	if (cc.status !== 0) return;
	for (const [source, out] of [
		["fake-node.c", path.join(pkg, "node", "node.exe")],
		["post-close.c", path.join(tmp, "post-close.exe")],
	]) {
		spawnSync(
			"x86_64-w64-mingw32-gcc",
			["-O2", "-o", out, path.join(win, "test", source)],
			{ stdio: "inherit" },
		);
	}
	fs.copyFileSync(
		path.join(repo, "launcher", "index.mjs"),
		path.join(pkg, "launcher", "index.mjs"),
	);

	// A stand-in for the NodeCG server: something the launcher can start, that
	// answers on the address it was given, so that "running" can be tested.
	fs.writeFileSync(
		path.join(appDir, "index.js"),
		[
			'const fs = require("node:fs");',
			'const http = require("node:http");',
			'const cfg = JSON.parse(fs.readFileSync("cfg/nodecg.json", "utf8"));',
			'http.createServer((_req, res) => res.end("ok")).listen(cfg.port, cfg.host);',
			"",
		].join("\n"),
	);

	// The real backend, on the host. The window under test talks to this.
	const port = await freePort();
	const serverPort = await freePort();
	const note = path.join(pkg, "launcher", "launcher-runtime.json");
	let backendExited = false;
	const backend = spawn(
		process.execPath,
		[
			path.join(repo, "launcher", "index.mjs"),
			"--app",
			appDir,
			"--no-open",
			"--control-port",
			String(port),
			"--host",
			"127.0.0.1",
			"--port",
			String(serverPort),
			// Its own file of remembered choices, and a language that does not
			// depend on the machine the test runs on.
			"--settings",
			path.join(tmp, "settings.json"),
			"--lang",
			"ru",
			// Where the window looks for a launcher that is already running.
			"--runtime",
			note,
		],
		{ stdio: "ignore" },
	);
	backend.on("exit", () => {
		backendExited = true;
	});
	const api = async (pathname) =>
		(await fetch(`http://127.0.0.1:${port}${pathname}`)).json();
	// A connection of its own every time: a kept-alive one that the server has
	// since closed would read as "does not answer".
	const serverAnswers = () =>
		new Promise((resolve) => {
			const request = http.get(
				{ host: "127.0.0.1", port: serverPort, agent: false, timeout: 3000 },
				(response) => {
					response.resume();
					resolve(response.statusCode === 200);
				},
			);
			request.on("error", () => resolve(false));
			request.on("timeout", () => request.destroy());
		});
	const fakeEnv = {
		...wineEnv,
		NOTGT_FAKE_PORT: String(port),
		NOTGT_FAKE_HEARTBEAT: winPath(heartbeat),
	};
	/** A session with the window: resolves with the window's id and a way to tell it ended. */
	const openWindow = async () => {
		const session = spawn(
			"wine",
			[exe, "--control-url", `http://127.0.0.1:${port}`],
			{
				cwd: pkg,
				env: wineEnv,
				stdio: "ignore",
			},
		);
		const life = { exited: false };
		session.on("exit", () => {
			life.exited = true;
		});
		const id = await waitFor("the window", () =>
			xdo("search", "--name", "^notGT$").split("\n").filter(Boolean).at(-1),
		);
		await sleep(1500);
		return { id, life, session };
	};
	const click = async (window, x, y) => {
		xdo("mousemove", "--window", window, String(x), String(y), "click", "1");
		await sleep(400);
	};
	const closeWindow = async ({ life, session }) => {
		spawnSync("wine", [path.join(tmp, "post-close.exe")], { env: wineEnv });
		await waitFor("the program to end", () => life.exited, 10_000).catch(
			() => null,
		);
		if (!life.exited) session.kill("SIGKILL");
		return life.exited;
	};

	try {
		await waitFor("the backend", () => api("/api/state").catch(() => null));

		// ------------------------------------------- started the way a user does
		// With no launcher running (no note of one), the program starts its own.
		fs.rmSync(note, { force: true });
		const first = spawnSync("wine", [exe, "--snapshot", winPath(shots)], {
			cwd: pkg,
			timeout: 180_000,
			env: fakeEnv,
		});
		check(
			"it starts its Node process and reads where to reach it",
			first.status === 0 && fs.existsSync(heartbeat),
			`exit ${first.status}`,
		);
		const pictures = ["main", "login", "network", "log"].filter((name) =>
			fs.existsSync(path.join(shots, `${name}.bmp`)),
		);
		check(
			"it draws its four windows",
			pictures.length === 4,
			pictures.join(", "),
		);
		if (pictures.includes("main")) {
			const main = path.join(shots, "main.bmp");
			check(
				"…on the brand's ground",
				pixel(main, 6, 6) === "0c2b25",
				pixel(main, 6, 6),
			);
			check(
				"…with the Signal-coloured primary button",
				pixel(main, 50, 286) === "ff5a8c",
				pixel(main, 50, 286),
			);
			// Somewhere along a line through the mark there is something that is not the ground.
			const drawn = Array.from({ length: 44 }, (_, i) =>
				pixel(main, 20 + i, 40),
			).filter((c) => c !== "0c2b25");
			check(
				"…and the logo in the header",
				drawn.length > 10,
				`${drawn.length} of 44 pixels`,
			);
		}
		spawnSync("wineserver", ["-k"], { env: wineEnv }); // the stand-in node is nobody's to stop
		// From here on there is a launcher running, and its note says so again.
		fs.writeFileSync(note, JSON.stringify({ pid: backend.pid, port }));

		// ------------------------------------------------------- using the window
		let window = await openWindow();

		await click(window.id, 442, 40); // EN
		const english = await waitFor("the language to change", async () => {
			const state = await api("/api/state");
			return state.lang === "en" ? state : null;
		}).catch(() => null);
		check(
			"the EN switch puts the launcher, and what the backend says, in English",
			Boolean(english) &&
				/[a-z]/i.test(english.statusText) &&
				!/[а-я]/i.test(english.statusText),
			english?.statusText,
		);
		await click(window.id, 402, 40); // RU
		const russian = await waitFor("the language to change back", async () => {
			const state = await api("/api/state");
			return state.lang === "ru" ? state : null;
		}).catch(() => null);
		check(
			"…and RU puts it back",
			Boolean(russian) && /[а-я]/i.test(russian.statusText),
			russian?.statusText,
		);
		const remembered = JSON.parse(
			fs.readFileSync(path.join(tmp, "settings.json"), "utf8"),
		);
		check(
			"the choice is remembered for the next start",
			remembered.lang === "ru",
			JSON.stringify(remembered),
		);

		await click(window.id, 100, 286); // «Запустить»
		const running = await waitFor(
			"the server to run",
			async () => {
				const state = await api("/api/state");
				return state.status === "running"
					? state
					: state.status === "error"
						? state
						: null;
			},
			30_000,
		);
		check(
			"«Запустить» starts the server",
			running.status === "running" && (await serverAnswers()),
			running.statusText,
		);

		// The sign-in window opens over the main one, so it comes after the click above.
		await click(window.id, 90, 511); // «Вход по паролю…»
		const login = await waitFor("the sign-in window", () =>
			xdo("search", "--name", "Вход по паролю")
				.split("\n")
				.filter(Boolean)
				.at(-1),
		);
		await sleep(700);
		const password = 'pa"ss\\w0rd';
		await click(login, 200, 174);
		xdo("type", "--delay", "20", "operator");
		await click(login, 200, 236);
		xdo("type", "--delay", "20", password);
		await sleep(300);
		await click(login, 120, 284); // «Задать администратора»
		const cfgPath = path.join(appDir, "cfg", "nodecg.json");
		const cfg = await waitFor("the sign-in to be written", () => {
			try {
				const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
				return parsed.login?.enabled ? parsed : null;
			} catch {
				return null;
			}
		});
		const saved = cfg.login.local.allowedUsers[0];
		const expected = crypto
			.createHmac("sha256", cfg.login.sessionSecret)
			.update(password, "utf8")
			.digest("hex");
		check(
			"the sign-in window sets the administrator",
			saved.username === "operator",
			saved.username,
		);
		check(
			"…with exactly the password that was typed",
			saved.password === `sha256:${expected}`,
		);
		await click(login, 316, 284); // «Отключить вход»
		const off = await waitFor("the sign-in to be switched off", () => {
			const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
			return parsed.login?.enabled === false ? parsed : null;
		}).catch(() => null);
		check("«Отключить вход» switches the sign-in off", Boolean(off));

		// ------------------------------------- closing it with the server running
		check("closing the window ends the program", await closeWindow(window));
		await sleep(1500);
		check(
			"…and leaves the server running",
			!backendExited &&
				(await serverAnswers()) &&
				(await api("/api/state")).status === "running",
		);

		// Started again, the program finds the launcher that stayed behind
		// (through the note it left) instead of starting another one.
		fs.rmSync(heartbeat, { force: true });
		const shots2 = path.join(tmp, "shots-running");
		fs.mkdirSync(shots2);
		const again = spawnSync("wine", [exe, "--snapshot", winPath(shots2)], {
			cwd: pkg,
			timeout: 180_000,
			env: fakeEnv,
		});
		check(
			"started again, it does not start a second launcher",
			again.status === 0 && !fs.existsSync(heartbeat),
		);
		const mainAgain = path.join(shots2, "main.bmp");
		check(
			"…and shows the server that is running",
			fs.existsSync(mainAgain) && pixel(mainAgain, 48, 102) === "ffd23f",
			fs.existsSync(mainAgain) ? pixel(mainAgain, 48, 102) : "no picture",
		);
		check(
			"…which the pictures did not disturb",
			!backendExited && (await serverAnswers()),
			`launcher ended: ${backendExited}; status: ${(await api("/api/state").catch(() => ({}))).status}`,
		);

		// ------------------------------------- closing it with the server stopped
		window = await openWindow();
		await click(window.id, 240, 286); // «Остановить»
		const stopped = await waitFor("the server to stop", async () => {
			const state = await api("/api/state");
			return state.status === "stopped" ? state : null;
		}).catch(() => null);
		check(
			"«Остановить» stops the server",
			Boolean(stopped) && !(await serverAnswers()),
		);
		await closeWindow(window);
		await waitFor(
			"the launcher's process to end",
			() => backendExited,
			10_000,
		).catch(() => null);
		check(
			"with the server stopped, closing the window ends the launcher's process too",
			backendExited,
		);
		check("…and takes its note away", !fs.existsSync(note));
	} finally {
		backend.kill();
		spawnSync("wineserver", ["-k"], { env: wineEnv });
	}
}

main()
	.catch((error) =>
		check("no unexpected error", false, error.stack ?? String(error)),
	)
	.finally(() => {
		if (failures.length === 0) fs.rmSync(tmp, { recursive: true, force: true });
		else console.log(`\nleft for inspection: ${tmp}`);
		console.log(
			failures.length === 0
				? "\nAll launcher window checks passed"
				: `\n${failures.length} check(s) failed`,
		);
		process.exit(failures.length === 0 ? 0 : 1);
	});
