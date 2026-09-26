#!/usr/bin/env node
/**
 * notGT launcher
 * --------------
 * A small, dependency-free local control panel for the notGT (NodeCG) server.
 *
 * It does three things:
 *   1. Serves a tiny local-only HTTP UI (bound to 127.0.0.1, never a network iface).
 *   2. Writes cfg/nodecg.json (host/port) and spawns `node index.js` with cwd = appDir.
 *      NodeCG only reads host/port from that config file; there are no CLI flags.
 *   3. Reports state/logs to the UI and manages the child process tree.
 *
 * No npm dependencies: Node builtins only. Runs on Windows, macOS and Linux.
 *
 * Usage:
 *   node launcher/index.mjs [--app <dir>] [--control-port <n>] [--no-open]
 *                           [--host <ip>] [--port <n>]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = "1.0.0";
const LOG_BUFFER_MAX = 400; // keep the last ~400 log lines
const READY_TIMEOUT_MS = 30_000; // how long we wait for the HTTP server to answer
const READY_POLL_MS = 400;
const KILL_GRACE_MS = 5_000; // SIGTERM -> wait -> SIGKILL grace period
const DEFAULT_PORT = 9090;
const PERSIST_PATH = path.join(__dirname, "launcher-config.json");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { app: null, controlPort: 0, open: true, host: null, port: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--app") out.app = argv[++i];
		else if (arg === "--control-port") out.controlPort = Number(argv[++i]);
		else if (arg === "--no-open") out.open = false;
		else if (arg === "--host") out.host = argv[++i];
		else if (arg === "--port") out.port = Number(argv[++i]);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

// Default app dir is the repo root (one level above launcher/).
const appDir = path.resolve(args.app ?? path.join(__dirname, ".."));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Map a bind host to a host that can actually be dialled from this machine. */
function openHostFor(host) {
	if (host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0") return "127.0.0.1";
	return host;
}

/** Format a host for use inside a URL (IPv6 needs brackets). */
function urlHost(host) {
	const h = openHostFor(host);
	return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

function guiUrlFor(host, port) {
	return `http://${urlHost(host)}:${port}/dashboard/`;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidPort(value) {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

// ---------------------------------------------------------------------------
// Network interfaces
// ---------------------------------------------------------------------------

/**
 * Build the interface list for the UI.
 * The two synthetic entries come first (spec: "Все интерфейсы" / "Только этот компьютер").
 * Internal addresses are skipped (loopback is covered by the synthetic entry) and
 * IPv6 link-local noise (fe80::/10) is dropped.
 */
function listInterfaces() {
	const list = [
		{
			id: "0.0.0.0",
			label: "Все интерфейсы (0.0.0.0)",
			address: "0.0.0.0",
			family: "IPv4",
			internal: false,
		},
		{
			id: "127.0.0.1",
			label: "Только этот компьютер (127.0.0.1)",
			address: "127.0.0.1",
			family: "IPv4",
			internal: true,
		},
	];

	const nics = os.networkInterfaces();
	for (const [name, addresses] of Object.entries(nics)) {
		for (const addr of addresses ?? []) {
			if (addr.internal) continue; // ::1 / 127.x handled by the synthetic localhost entry
			const isV4 = addr.family === "IPv4" || addr.family === 4;
			const family = isV4 ? "IPv4" : "IPv6";
			if (!isV4 && /^fe80:/i.test(addr.address)) continue; // link-local noise
			list.push({
				id: addr.address,
				label: `${name} — ${addr.address}`,
				address: addr.address,
				family,
				internal: false,
			});
		}
	}
	return list;
}

function defaultHost() {
	// Prefer the first real, non-internal IPv4 address (skip the synthetic entries).
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const addr of addresses ?? []) {
			if (addr.internal) continue;
			if (addr.family === "IPv4" || addr.family === 4) return addr.address;
		}
	}
	return "127.0.0.1";
}

// ---------------------------------------------------------------------------
// Persisted launcher settings (last chosen host/port)
// ---------------------------------------------------------------------------

function readPersisted() {
	try {
		const parsed = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf8"));
		if (parsed && typeof parsed === "object") {
			return {
				host: typeof parsed.host === "string" ? parsed.host : null,
				port: isValidPort(parsed.port) ? parsed.port : null,
			};
		}
	} catch {
		/* missing or corrupt -> ignore */
	}
	return { host: null, port: null };
}

function persistSettings(host, port) {
	try {
		fs.writeFileSync(PERSIST_PATH, JSON.stringify({ host, port }, null, 2) + "\n", "utf8");
	} catch {
		/* ignore write failures - persistence is best effort */
	}
}

// ---------------------------------------------------------------------------
// Launcher state
// ---------------------------------------------------------------------------

const persisted = readPersisted();

const state = {
	host: args.host ?? persisted.host ?? defaultHost(),
	port: isValidPort(args.port) ? args.port : (persisted.port ?? DEFAULT_PORT),
	status: "stopped", // stopped | starting | running | stopping | error
	statusText: "Сервер не запущен.",
	child: null,
	logs: [], // ring buffer of the last LOG_BUFFER_MAX lines
	logCount: 0, // total number of lines ever produced (monotonic)
};

function pushLog(line) {
	state.logs.push(line);
	state.logCount++;
	if (state.logs.length > LOG_BUFFER_MAX) state.logs.shift();
}

/** The first buffer index currently held (accounts for ring trimming). */
function bufferStart() {
	return state.logCount - state.logs.length;
}

function statePayload() {
	return {
		version: VERSION,
		appDir,
		nodeVersion: process.version,
		platform: process.platform,
		host: state.host,
		port: state.port,
		status: state.status,
		statusText: state.statusText,
		running: state.status === "running",
		guiUrl: guiUrlFor(state.host, state.port),
		configPath: path.join(appDir, "cfg", "nodecg.json"),
		interfaces: listInterfaces(),
		logs: state.logs.slice(),
		logCount: state.logCount,
	};
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

/** Pipe a child stream into the ring buffer, splitting on newlines. */
function attachLogs(child) {
	const consume = (stream) => {
		let partial = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			partial += chunk;
			let idx;
			while ((idx = partial.indexOf("\n")) >= 0) {
				pushLog(partial.slice(0, idx).replace(/\r$/, ""));
				partial = partial.slice(idx + 1);
			}
		});
		stream.on("end", () => {
			if (partial) {
				pushLog(partial.replace(/\r$/, ""));
				partial = "";
			}
		});
	};
	if (child.stdout) consume(child.stdout);
	if (child.stderr) consume(child.stderr);
}

/** Try to bind host:port to see whether it is free. */
function checkPortFree(host, port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", (err) => resolve({ ok: false, code: err.code, message: err.message }));
		probe.once("listening", () => probe.close(() => resolve({ ok: true })));
		try {
			probe.listen({ host, port, exclusive: true });
		} catch (err) {
			resolve({ ok: false, code: err.code, message: err.message });
		}
	});
}

/** Any HTTP response - even an error page - means NodeCG is answering. */
function probeHttp(host, port) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let req;
		try {
			req = http.get({ host: openHostFor(host), port, path: "/", timeout: 2000 }, (res) => {
				res.resume();
				done(true);
			});
		} catch {
			done(false);
			return;
		}
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
	});
}

/** Wait for a child to exit, up to `ms`. Returns true if it exited. */
function waitExit(child, ms) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.removeListener("exit", onExit);
			resolve(false);
		}, ms);
		function onExit() {
			clearTimeout(timer);
			resolve(true);
		}
		child.once("exit", onExit);
	});
}

/**
 * Ask the child (and its whole tree) to terminate.
 * Windows: `taskkill /PID <pid> /T /F` is the only reliable way to kill a tree.
 * POSIX:   SIGTERM first; the caller escalates to SIGKILL after a grace period.
 */
function killTree(child) {
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => {
				try {
					child.kill();
				} catch {
					/* already gone */
				}
			});
		} catch {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		}
		return Promise.resolve();
	}
	try {
		child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	return Promise.resolve();
}

/** Best-effort synchronous kill used from the `exit` handler. */
function hardKillChild() {
	const child = state.child;
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		/* ignore */
	}
}

/** Read + merge cfg/nodecg.json so every unrelated key is preserved. */
async function writeNodecgConfig(host, port) {
	const cfgDir = path.join(appDir, "cfg");
	const cfgPath = path.join(cfgDir, "nodecg.json");

	let existing = {};
	try {
		const raw = await fsp.readFile(cfgPath, "utf8");
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
		} catch {
			/* tolerate invalid config; start from scratch */
		}
	} catch {
		/* missing config is fine */
	}

	const merged = { ...existing, host, port };
	await fsp.mkdir(cfgDir, { recursive: true });
	await fsp.writeFile(cfgPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

async function startServer(requestedHost, requestedPort) {
	if (state.status === "starting" || state.status === "running" || state.status === "stopping") {
		return {
			http: 409,
			body: { ...statePayload(), error: "Сервер уже запущен или запускается." },
		};
	}

	const host = typeof requestedHost === "string" && requestedHost.trim() ? requestedHost.trim() : "0.0.0.0";
	const port = Number(requestedPort);
	if (!isValidPort(port)) {
		return {
			http: 400,
			body: { ...statePayload(), error: "Некорректный порт: укажите число от 1 до 65535." },
		};
	}

	// Refuse to spawn if something already holds the port.
	const free = await checkPortFree(host, port);
	if (!free.ok) {
		state.status = "error";
		state.statusText =
			free.code === "EADDRINUSE"
				? `Порт ${port} уже занят на ${host}. Выберите другой порт или остановите занявший его процесс.`
				: `Не удалось занять ${host}:${port} (${free.code ?? "ошибка"}: ${free.message ?? "unknown"}).`;
		pushLog(`[launcher] ${state.statusText}`);
		return { http: 409, body: { ...statePayload(), error: state.statusText } };
	}

	try {
		await writeNodecgConfig(host, port);
	} catch (err) {
		state.status = "error";
		state.statusText = `Не удалось записать cfg/nodecg.json: ${err.message}`;
		pushLog(`[launcher] ${state.statusText}`);
		return { http: 500, body: { ...statePayload(), error: state.statusText } };
	}

	state.host = host;
	state.port = port;
	persistSettings(host, port);

	state.status = "starting";
	state.statusText = `Запуск сервера на ${host}:${port}…`;
	pushLog(`[launcher] Запуск: ${process.execPath} index.js (cwd=${appDir}, ${host}:${port})`);

	let child;
	try {
		child = spawn(process.execPath, ["index.js"], {
			cwd: appDir,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (err) {
		state.status = "error";
		state.statusText = `Не удалось запустить node index.js: ${err.message}`;
		pushLog(`[launcher] ${state.statusText}`);
		return { http: 500, body: { ...statePayload(), error: state.statusText } };
	}

	state.child = child;
	attachLogs(child);

	let spawnError = null;
	child.on("error", (err) => {
		spawnError = err;
	});

	child.on("exit", (code, signal) => {
		if (state.child !== child) return;
		state.child = null;
		if (state.status === "stopping") {
			state.status = "stopped";
			state.statusText = "Сервер остановлен.";
		} else if (state.status === "running" || state.status === "starting") {
			if (code === 0) {
				state.status = "stopped";
				state.statusText = "Сервер завершил работу.";
			} else {
				state.status = "error";
				state.statusText = `Сервер неожиданно завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}).`;
			}
		}
		pushLog(`[launcher] Процесс завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}).`);
	});

	// Poll until the HTTP server answers, the child dies, or we time out.
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (state.child !== child) break; // stopped from under us
		if (await probeHttp(host, port)) {
			state.status = "running";
			state.statusText = `Сервер работает на ${openHostFor(host)}:${port}.`;
			pushLog(`[launcher] Сервер отвечает: ${guiUrlFor(host, port)}`);
			break;
		}
		if (child.exitCode !== null || child.signalCode !== null) break;
		if (spawnError) break;
		await delay(READY_POLL_MS);
	}

	if (state.status === "starting") {
		// Timed out (or the process vanished) without becoming ready.
		if (state.child === child) {
			await stopChild(child);
		}
		const tail = state.logs.slice(-8).join("\n");
		state.status = "error";
		state.statusText = spawnError
			? `Не удалось запустить сервер: ${spawnError.message}`
			: `Сервер не ответил за ${READY_TIMEOUT_MS / 1000} с. Последние строки журнала:\n${tail}`;
		pushLog(`[launcher] ${state.statusText}`);
	}

	return { http: 200, body: statePayload() };
}

async function stopChild(child) {
	if (!child) return;
	await killTree(child);
	const exited = await waitExit(child, KILL_GRACE_MS);
	if (!exited) {
		// Grace period expired -> force kill (POSIX; on Windows taskkill already forced).
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		await waitExit(child, 2000);
	}
	if (state.child === child) state.child = null;
}

async function stopServer() {
	const child = state.child;
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		state.child = null;
		state.status = "stopped";
		state.statusText = "Сервер не запущен.";
		return { http: 200, body: statePayload() };
	}

	state.status = "stopping";
	state.statusText = "Остановка сервера…";
	await stopChild(child);
	state.status = "stopped";
	state.statusText = "Сервер остановлен.";
	return { http: 200, body: statePayload() };
}

// ---------------------------------------------------------------------------
// Opening URLs / windows (best effort, never fatal)
// ---------------------------------------------------------------------------

function openUrl(url) {
	try {
		if (process.platform === "win32") {
			// Prefer an Edge "app" window (no browser chrome). `msedge` may not be
			// on PATH, in which case the spawn emits an error and we fall back to
			// the shell `start` command.
			const edge = spawn("msedge", [`--app=${url}`], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			edge.on("error", () => {
				try {
					spawn("cmd", ["/c", "start", "", url], {
						detached: true,
						stdio: "ignore",
						windowsHide: true,
					}).unref();
				} catch {
					/* ignore */
				}
			});
			edge.unref();
			return true;
		}

		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
		child.on("error", () => {
			/* xdg-open etc. may be missing - not fatal */
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// HTTP control server (127.0.0.1 only)
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1_000_000) throw new Error("Тело запроса слишком большое.");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

async function handleRequest(req, res) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const { pathname } = url;
	const method = req.method ?? "GET";

	if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
		let html;
		try {
			html = await fsp.readFile(path.join(__dirname, "ui.html"), "utf8");
		} catch (err) {
			sendJson(res, 500, { error: `Не удалось прочитать ui.html: ${err.message}` });
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(html);
		return;
	}

	if (method === "GET" && pathname === "/api/state") {
		sendJson(res, 200, statePayload());
		return;
	}

	if (method === "GET" && pathname === "/api/logs") {
		let since = Number(url.searchParams.get("since") ?? "0");
		if (!Number.isFinite(since) || since < 0) since = 0;
		const start = bufferStart();
		if (since < start) since = start;
		sendJson(res, 200, {
			lines: state.logs.slice(since - start),
			next: state.logCount,
		});
		return;
	}

	if (method === "POST" && pathname === "/api/start") {
		const body = await readJsonBody(req);
		const result = await startServer(body.host, body.port);
		sendJson(res, result.http, result.body);
		return;
	}

	if (method === "POST" && pathname === "/api/stop") {
		const result = await stopServer();
		sendJson(res, result.http, result.body);
		return;
	}

	if (method === "POST" && pathname === "/api/open") {
		const body = await readJsonBody(req);
		const target = typeof body.url === "string" && body.url ? body.url : guiUrlFor(state.host, state.port);
		const ok = openUrl(target);
		sendJson(res, 200, { ok });
		return;
	}

	sendJson(res, 404, { error: "Not found" });
}

const controlServer = http.createServer((req, res) => {
	handleRequest(req, res).catch((err) => {
		try {
			sendJson(res, 500, { error: err?.message ?? String(err) });
		} catch {
			/* response may already be sent */
		}
	});
});

controlServer.on("error", (err) => {
	process.stderr.write(`[launcher] control server error: ${err.message}\n`);
	process.exit(1);
});

// ---------------------------------------------------------------------------
// Shutdown handling - always take the child down with us
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function gracefulShutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		await stopServer();
	} catch {
		/* ignore */
	}
	try {
		controlServer.close();
	} catch {
		/* ignore */
	}
	process.exit(code);
}

process.on("SIGINT", () => void gracefulShutdown(0));
process.on("SIGTERM", () => void gracefulShutdown(0));
process.on("exit", () => hardKillChild());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const listenPort = isValidPort(args.controlPort) || args.controlPort === 0 ? args.controlPort : 0;

controlServer.listen(listenPort, "127.0.0.1", () => {
	const actualPort = controlServer.address().port;
	const controlUrl = `http://127.0.0.1:${actualPort}`;

	// The one and only stdout line. Everything else (child output) stays in the buffer.
	process.stdout.write(`notGT launcher on ${controlUrl}\n`);

	if (args.open) {
		openUrl(`${controlUrl}/`);
	}
});
