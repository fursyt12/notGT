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

const VERSION = "1.1.0";
const LOG_BUFFER_MAX = 400; // keep the last ~400 log lines
// The first launch on Windows can be slow: Defender scans the ~44k extracted
// files, SQLite initialises and chokidar walks the tree. 30 s proved too tight,
// so the default is generous and `--ready-timeout` can override it.
let READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 400;
const READY_NOTICE_MS = 10_000; // how often to say "still waiting" in the log
// When the server answers on 127.0.0.1 but not on the chosen address, it is
// running and the *network* is the problem - nearly always the Windows
// firewall dropping inbound packets. Sitting out the whole READY_TIMEOUT_MS
// for that is pure wasted time, so report it as soon as we are sure.
const UNREACHABLE_NOTICE_MS = 8_000;
const FIREWALL_CACHE_MS = 10_000; // how long a `netsh` answer is reused
const KILL_GRACE_MS = 5_000; // SIGTERM -> wait -> SIGKILL grace period
const DEFAULT_PORT = 9090;
const PERSIST_PATH = path.join(__dirname, "launcher-config.json");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = {
		app: null,
		controlPort: 0,
		open: true,
		host: null,
		port: null,
		readyTimeout: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--app") out.app = argv[++i];
		else if (arg === "--control-port") out.controlPort = Number(argv[++i]);
		else if (arg === "--no-open") out.open = false;
		else if (arg === "--host") out.host = argv[++i];
		else if (arg === "--port") out.port = Number(argv[++i]);
		else if (arg === "--ready-timeout") out.readyTimeout = Number(argv[++i]);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

if (Number.isFinite(args.readyTimeout) && args.readyTimeout > 0) {
	READY_TIMEOUT_MS = args.readyTimeout * 1000;
}

// Default app dir is the repo root (one level above launcher/).
const appDir = path.resolve(args.app ?? path.join(__dirname, ".."));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Map a bind host to a host that can actually be dialled from this machine. */
function openHostFor(host) {
	if (host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0")
		return "127.0.0.1";
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

const ANY_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

function isAnyHost(host) {
	return ANY_HOSTS.has(host);
}

function isLoopbackHost(host) {
	return host === "127.0.0.1" || host === "::1";
}

/**
 * NodeCG's own default is "listen everywhere", and that is what we keep for
 * every choice except the explicit loopback one.
 *
 * Binding a single network card is what makes Windows Firewall drop *even
 * same-machine* connections to that address, and it leaves 127.0.0.1 with no
 * listener at all - so the launcher could no longer prove that the server is
 * alive while the chosen address stays silent. The dropdown therefore decides
 * the *advertised* address (links + probe), not the bind address.
 */
function bindHostFor(host) {
	if (isLoopbackHost(host)) return "127.0.0.1";
	return net.isIPv6(host) ? "::" : "0.0.0.0";
}

/**
 * Interface names that are normally *not* the address an operator should hand
 * to another device: Docker/WSL/Hyper-V/VirtualBox bridges and tunnels.
 */
const VIRTUAL_IFACE =
	/(docker|veth|bridge|br-|virbr|vmnet|vbox|virtualbox|host-only|hyper-?v|vethernet|wsl|loopback|tailscale|zerotier|zt[0-9a-f]+|tun[0-9]|tap[0-9]|utun|teredo|isatap)/i;

function ifaceIsVirtual(name) {
	return VIRTUAL_IFACE.test(name);
}

/**
 * Prefer an address that is reachable from the studio LAN: a real card, an IPv4
 * address, and a private range in the usual order of likelihood.
 */
function addressScore(entry) {
	let score = 0;
	if (entry.virtual) score -= 100;
	if (entry.family === "IPv4") score += 20;
	const addr = entry.address;
	if (/^169\.254\./.test(addr)) score -= 80;
	if (/^192\.168\./.test(addr)) score += 30;
	else if (/^10\./.test(addr)) score += 20;
	else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr)) score += 10;
	return score;
}

/** The best real network address of this machine, for "all interfaces". */
function primaryAddress() {
	const candidates = listInterfaces().filter(
		(iface) => iface.address !== "0.0.0.0" && iface.address !== "127.0.0.1",
	);
	if (candidates.length === 0) return null;
	candidates.sort(
		(a, b) =>
			addressScore(b) - addressScore(a) ||
			(a.family === "IPv4" ? -1 : 1) - (b.family === "IPv4" ? -1 : 1),
	);
	return candidates[0].address;
}

/** The address that goes into links, and the one the launcher probes. */
function advertiseHostFor(host) {
	if (isAnyHost(host)) return primaryAddress() ?? "127.0.0.1";
	return host;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns a log tail into a concrete, actionable hint when we can recognise it. */
function hintForLogTail(tail) {
	const text = tail || "";
	if (/EADDRINUSE/i.test(text)) {
		return "Похоже, порт уже занят другим процессом — выберите другой порт.";
	}
	if (/NODE_MODULE_VERSION|compiled against a different Node/i.test(text)) {
		return (
			"Нативный модуль собран под другую версию Node. Пересоберите пакет тем же " +
			"Node.js, который лежит в папке node\\."
		);
	}
	if (/Cannot find module/i.test(text)) {
		return (
			"Сервер не нашёл модуль: скорее всего архив распакован не полностью. " +
			"Распакуйте ZIP целиком в пустую папку."
		);
	}
	if (/EACCES|EPERM/i.test(text)) {
		return (
			"Нет прав на запись. Не запускайте из Program Files и не распаковывайте " +
			"в системные папки."
		);
	}
	if (/ENOENT/i.test(text) && /(cfg|nodecg\.json|SQLITE|sqlite)/i.test(text)) {
		return "Не читается app\\cfg или app\\db — проверьте, что папки распакованы.";
	}
	return "";
}

/**
 * Explains a failed start instead of just saying "no answer".
 * Only reached when *nothing* answered (neither the advertised address nor
 * loopback), so it looks for the classic reasons: a port clash, a crash, or a
 * second instance already running on the default port.
 */
async function startFailureReport(host, port, bindHost, tail) {
	const dialHost = openHostFor(host);
	const parts = [
		`Сервер не ответил за ${Math.round(READY_TIMEOUT_MS / 1000)} с ` +
			`(проверяли ${dialHost}:${port} и 127.0.0.1:${port}).`,
	];

	const onChosen =
		dialHost === "127.0.0.1" ? false : await probeHttp(host, port);
	const onLoopback = await probeHttp("127.0.0.1", port);
	if (onChosen && !onLoopback) {
		parts.push(
			`При этом ${dialHost}:${port} отвечает — похоже, сервер слушает только этот ` +
				`адрес (так было в старых сборках). Перезапустите лончер.`,
		);
	}
	if (onLoopback && !onChosen) {
		parts.push(
			`При этом на 127.0.0.1:${port} он отвечает, а на ${dialHost}:${port} — нет: ` +
				`обычно это брандмауэр. Нажмите «Проверить доступность» / «Разрешить порт».`,
		);
	}
	if (bindHost && bindHost !== dialHost) {
		parts.push(`Сервер должен был слушать ${bindHost}:${port}.`);
	}

	if (port !== DEFAULT_PORT && (await probeHttp("127.0.0.1", DEFAULT_PORT))) {
		parts.push(
			`Порт ${DEFAULT_PORT} при этом отвечает: возможно, сервер поднялся на нём, а не ` +
				`на выбранном ${port} (тогда проверьте app\\cfg\\nodecg.json), либо на ` +
				`${DEFAULT_PORT} уже запущен другой экземпляр NodeCG.`,
		);
	}

	const hint = hintForLogTail(tail);
	if (hint) parts.push(hint);
	parts.push("Последние строки журнала:", tail || "(журнал пуст)");
	return parts.join("\n");
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

	// Real network cards first, virtual adapters last: on Windows the OS often
	// lists vEthernet/WSL/VirtualBox addresses before Wi-Fi, and picking one of
	// those is a reliable way to end up with an unreachable address.
	const nics = os.networkInterfaces();
	const real = [];
	const virtual = [];
	for (const [name, addresses] of Object.entries(nics)) {
		for (const addr of addresses ?? []) {
			if (addr.internal) continue; // ::1 / 127.x handled by the synthetic localhost entry
			const isV4 = addr.family === "IPv4" || addr.family === 4;
			const family = isV4 ? "IPv4" : "IPv6";
			if (!isV4 && /^fe80:/i.test(addr.address)) continue; // link-local noise
			const entry = {
				id: addr.address,
				label: `${name} — ${addr.address}`,
				address: addr.address,
				family,
				internal: false,
			};
			if (ifaceIsVirtual(name)) {
				entry.label += " (виртуальный)";
				entry.virtual = true;
				virtual.push(entry);
			} else {
				real.push(entry);
			}
		}
	}
	const byScore = (a, b) => addressScore(b) - addressScore(a);
	real.sort(byScore);
	virtual.sort(byScore);
	return [...list, ...real, ...virtual];
}

function defaultHost() {
	// Listen on every interface by default, exactly like NodeCG itself does.
	// Binding a single card is what makes Windows Firewall block even
	// same-machine connections, and it leaves 127.0.0.1 without a listener -
	// so "the server never answered" was the only thing we could report.
	return "0.0.0.0";
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
		fs.writeFileSync(
			PERSIST_PATH,
			JSON.stringify({ host, port }, null, 2) + "\n",
			"utf8",
		);
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
	warning: "", // set when the server is up but unreachable on the chosen address
	reach: null, // last { dialHost, port, chosenOk, loopbackOk }
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

/**
 * The three URLs of the current selection.
 *
 * `guiUrl` is what «Открыть GUI» uses: for "all interfaces" that stays 127.0.0.1
 * (it can never be blocked), for a concrete card it is that card - unless we
 * already know the card is silent, in which case loopback is used so the
 * operator is not locked out of their own dashboard.
 */
function guiUrls() {
	const loopbackUrl = `http://127.0.0.1:${state.port}/dashboard/`;
	const networkUrl = guiUrlFor(currentAdvertiseHost(), state.port);
	const preferred = isAnyHost(state.host) ? loopbackUrl : networkUrl;
	const blocked =
		state.reach !== null &&
		state.reach !== undefined &&
		!state.reach.chosenOk &&
		state.reach.loopbackOk;
	return {
		guiUrl: blocked ? loopbackUrl : preferred,
		networkUrl,
		loopbackUrl,
		guiUrlFallback: blocked && !isAnyHost(state.host),
	};
}

/** The URL that is actually usable right now (falls back to loopback). */
function effectiveGuiUrl() {
	return guiUrls().guiUrl;
}

function statePayload() {
	const urls = guiUrls();
	return {
		version: VERSION,
		appDir,
		nodeVersion: process.version,
		platform: process.platform,
		host: state.host,
		bindHost: state.bindHost ?? bindHostFor(state.host),
		advertiseHost: currentAdvertiseHost(),
		port: state.port,
		status: state.status,
		statusText: state.statusText,
		running: state.status === "running",
		warning: state.warning,
		reach: state.reach,
		firewall: firewallInfo(state.port),
		...urls,
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
		probe.once("error", (err) =>
			resolve({ ok: false, code: err.code, message: err.message }),
		);
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
			req = http.get(
				{ host: openHostFor(host), port, path: "/", timeout: 2000 },
				(res) => {
					res.resume();
					done(true);
				},
			);
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

// ---------------------------------------------------------------------------
// Reachability: "is the server up?" vs "can anyone actually get to it?"
// ---------------------------------------------------------------------------

/**
 * Probe both the address the user chose and loopback.
 *
 * Binding a single network card is what makes Windows Firewall drop even
 * same-machine connections to that address ("бесконечная загрузка" in the
 * browser, and the readiness probe never passing). Telling those two states
 * apart is the whole point of this function.
 */
async function measureReach(host, port, { loopbackOnly = false } = {}) {
	const dialHost = openHostFor(host);
	const direct = dialHost === "127.0.0.1" || dialHost === "::1";
	const chosenOk = await probeHttp(host, port);
	const loopbackOk = direct ? chosenOk : await probeHttp("127.0.0.1", port);
	return {
		host,
		dialHost,
		port,
		loopbackOnly: loopbackOnly || direct,
		chosenOk,
		loopbackOk,
	};
}

/** The advertised address of the current selection (never `0.0.0.0`). */
function currentAdvertiseHost() {
	return state.advertiseHost ?? advertiseHostFor(state.host);
}

function measureCurrentReach() {
	return measureReach(currentAdvertiseHost(), state.port, {
		loopbackOnly: isLoopbackHost(state.host),
	});
}

// ---------------------------------------------------------------------------
// Windows firewall (best effort, never fatal)
// ---------------------------------------------------------------------------

/** Rule names must not contain spaces: netsh re-parses its raw command line. */
function firewallRuleName(port) {
	return `notGT-NodeCG-TCP-${port}`;
}

function firewallSupported() {
	return process.platform === "win32";
}

function runSync(cmd, args) {
	let res;
	try {
		res = spawnSync(cmd, args, {
			encoding: "utf8",
			windowsHide: true,
			timeout: 20_000,
		});
	} catch (err) {
		return { ok: false, status: null, out: "", error: err.message };
	}
	return {
		ok: !res.error && res.status === 0,
		status: res.status,
		out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
		error: res.error ? res.error.message : "",
	};
}

const firewallCache = new Map(); // port -> { exists, at }

/**
 * Does an inbound allow rule for this port already exist?
 * The `netsh` output is localized, but our own rule name is not, so a plain
 * substring check works on any Windows display language.
 */
function firewallRuleExists(port, { force = false } = {}) {
	if (!firewallSupported()) return false;
	const cached = firewallCache.get(port);
	if (!force && cached && Date.now() - cached.at < FIREWALL_CACHE_MS)
		return cached.exists;
	const name = firewallRuleName(port);
	const res = runSync("netsh", [
		"advfirewall",
		"firewall",
		"show",
		"rule",
		`name=${name}`,
		"dir=in",
	]);
	const exists = res.out.includes(name);
	firewallCache.set(port, { exists, at: Date.now() });
	return exists;
}

function firewallInfo(port) {
	const supported = firewallSupported();
	return {
		supported,
		port,
		ruleName: firewallRuleName(port),
		ruleExists: supported ? firewallRuleExists(port) : false,
	};
}

/**
 * Run a netsh command elevated (UAC). The command goes into a throwaway .cmd
 * file so that no layer of cmd/PowerShell/netsh quoting can mangle it.
 */
function runElevated(command) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-fw-"));
	const file = path.join(dir, "firewall.cmd");
	try {
		fs.writeFileSync(file, `@echo off\r\n${command}\r\n`, "utf8");
		return runSync("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$p = Start-Process -FilePath '${file}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
		]);
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Add an inbound allow rule for the port, for every network profile.
 * First try unelevated (works if the launcher already has admin rights), then
 * fall back to a UAC prompt, then *verify* - the exit code of an elevated
 * helper is not worth trusting when a plain query can answer directly.
 */
function addFirewallRule(port) {
	if (!firewallSupported()) {
		return {
			ok: false,
			message:
				"Управление брандмауэром доступно только в Windows. Проверьте " +
				"брандмауэр системы вручную.",
		};
	}
	const name = firewallRuleName(port);
	if (firewallRuleExists(port, { force: true })) {
		return { ok: true, existed: true, message: "Правило уже существует." };
	}
	const direct = runSync("netsh", [
		"advfirewall",
		"firewall",
		"add",
		"rule",
		`name=${name}`,
		"dir=in",
		"action=allow",
		`protocol=TCP`,
		`localport=${port}`,
		"profile=any",
	]);
	if (firewallRuleExists(port, { force: true })) {
		return { ok: true, existed: false, message: "Правило добавлено." };
	}
	const elevated = runElevated(
		`netsh advfirewall firewall add rule name=${name} dir=in action=allow protocol=TCP localport=${port} profile=any`,
	);
	if (firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: false,
			message: "Правило добавлено (с правами администратора).",
		};
	}
	return {
		ok: false,
		message:
			"Не удалось добавить правило. Если запрос UAC был отклонён — нажмите " +
			`кнопку ещё раз и подтвердите. Ответ системы: ${(elevated.out || direct.out || direct.error || "нет").trim().slice(0, 300)}`,
	};
}

function removeFirewallRule(port) {
	if (!firewallSupported()) {
		return {
			ok: false,
			message: "Управление брандмауэром доступно только в Windows.",
		};
	}
	if (!firewallRuleExists(port, { force: true })) {
		return { ok: true, existed: false, message: "Правила и так нет." };
	}
	const name = firewallRuleName(port);
	runSync("netsh", [
		"advfirewall",
		"firewall",
		"delete",
		"rule",
		`name=${name}`,
	]);
	if (!firewallRuleExists(port, { force: true })) {
		return { ok: true, existed: true, message: "Правило удалено." };
	}
	runElevated(`netsh advfirewall firewall delete rule name=${name}`);
	if (!firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: true,
			message: "Правило удалено (с правами администратора).",
		};
	}
	return { ok: false, message: "Не удалось удалить правило." };
}

/**
 * A system-wide proxy makes the browser send http://192.168.x.x:9090 to the
 * proxy instead of to the local machine. Loopback is normally on the bypass
 * list, so "everything except 127.0.0.1 hangs" is the classic symptom.
 */
function readWindowsProxy() {
	if (!firewallSupported()) return null;
	const key =
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
	const read = (name) => {
		const res = runSync("reg", ["query", key, "/v", name]);
		const match = res.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, "i"));
		return match ? match[1].trim() : "";
	};
	const enabled = read("ProxyEnable") === "0x1";
	return {
		enabled,
		server: read("ProxyServer"),
		override: read("ProxyOverride"),
	};
}

/** Human-readable, actionable list for the chosen address. */
async function diagnose() {
	// Always measure afresh: this is what the user presses after changing a
	// firewall rule, so a cached answer would be actively misleading.
	const reach = await measureCurrentReach();
	const firewall = firewallInfo(state.port);
	const proxy = readWindowsProxy();
	const verdict = [];

	if (!state.child) {
		verdict.push({
			level: "info",
			text: "Сервер сейчас не запущен — сначала нажмите «Запустить».",
		});
	} else if (reach.chosenOk) {
		verdict.push({
			level: "ok",
			text: `Адрес ${reach.dialHost}:${reach.port} отвечает.`,
		});
	} else if (reach.loopbackOk) {
		verdict.push({
			level: "warn",
			text: `Сервер работает: 127.0.0.1:${reach.port} отвечает, а ${reach.dialHost}:${reach.port} — нет.`,
		});
		verdict.push({
			level: "warn",
			text: firewall.supported
				? firewall.ruleExists
					? `Правило «${firewall.ruleName}» есть, но пакеты всё равно не проходят: проверьте, что сеть в Windows помечена как «Частная», и разрешите node.exe входящие подключения.`
					: "Входящие подключения режет брандмауэр Windows. Нажмите «Разрешить порт» — лончер добавит правило для всех профилей сети (потребуются права администратора)."
				: "Проверьте брандмауэр и маршрутизацию до этого адреса.",
		});
	} else {
		verdict.push({
			level: "error",
			text: `Сервер не отвечает ни на ${reach.dialHost}:${reach.port}, ни на 127.0.0.1:${reach.port}.`,
		});
	}

	if (proxy && proxy.enabled && !reach.loopbackOnly) {
		const bypassed = (proxy.override || "")
			.split(";")
			.some((entry) => entry.trim() === reach.dialHost);
		if (!bypassed) {
			verdict.push({
				level: "warn",
				text: `В Windows включён прокси-сервер (${proxy.server || "адрес не указан"}). Браузер может отправлять запросы к ${reach.dialHost} через прокси — тогда страница грузится бесконечно. Добавьте адрес в исключения прокси или отключите прокси.`,
			});
		}
	}

	// Everything can answer locally and the port still be closed to the rest of
	// the studio: Windows Firewall governs inbound connections per program, so a
	// successful self-probe proves nothing about other devices.
	if (
		state.child &&
		firewall.supported &&
		!firewall.ruleExists &&
		!reach.loopbackOnly &&
		reach.chosenOk
	) {
		verdict.push({
			level: "info",
			text:
				`Правила брандмауэра для порта ${state.port} нет. С этого компьютера всё ` +
				`открывается, но другие устройства (OBS на второй машине, Bitfocus Companion, ` +
				`телефон) могут не подключиться. Нажмите «Разрешить порт» — правило будет ` +
				`создано для всех профилей сети.`,
		});
	}

	return { reach, firewall, proxy, verdict };
}

/** Wait for a child to exit, up to `ms`. Returns true if it exited. */
function waitExit(child, ms) {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(true);
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
			const killer = spawn(
				"taskkill",
				["/PID", String(child.pid), "/T", "/F"],
				{
					stdio: "ignore",
					windowsHide: true,
				},
			);
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
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
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
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				existing = parsed;
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
	if (
		state.status === "starting" ||
		state.status === "running" ||
		state.status === "stopping"
	) {
		return {
			http: 409,
			body: { ...statePayload(), error: "Сервер уже запущен или запускается." },
		};
	}

	const host =
		typeof requestedHost === "string" && requestedHost.trim()
			? requestedHost.trim()
			: "0.0.0.0";
	const port = Number(requestedPort);
	if (!isValidPort(port)) {
		return {
			http: 400,
			body: {
				...statePayload(),
				error: "Некорректный порт: укажите число от 1 до 65535.",
			},
		};
	}

	const bindHost = bindHostFor(host);
	const advertiseHost = advertiseHostFor(host);

	// Refuse to spawn if something already holds the port. Check the *bind*
	// address, so a conflict on any interface is caught.
	const free = await checkPortFree(bindHost, port);
	if (!free.ok) {
		state.status = "error";
		state.statusText =
			free.code === "EADDRINUSE"
				? `Порт ${port} уже занят на ${bindHost}. Выберите другой порт или остановите занявший его процесс.`
				: `Не удалось занять ${bindHost}:${port} (${free.code ?? "ошибка"}: ${free.message ?? "unknown"}).`;
		pushLog(`[launcher] ${state.statusText}`);
		return { http: 409, body: { ...statePayload(), error: state.statusText } };
	}

	try {
		await writeNodecgConfig(bindHost, port);
	} catch (err) {
		state.status = "error";
		state.statusText = `Не удалось записать cfg/nodecg.json: ${err.message}`;
		pushLog(`[launcher] ${state.statusText}`);
		return { http: 500, body: { ...statePayload(), error: state.statusText } };
	}

	state.host = host;
	state.bindHost = bindHost;
	state.advertiseHost = advertiseHost;
	state.port = port;
	persistSettings(host, port);

	state.status = "starting";
	state.statusText = `Запуск сервера на ${advertiseHost}:${port}…`;
	pushLog(
		`[launcher] Запуск: ${process.execPath} index.js (cwd=${appDir}, ${advertiseHost}:${port})`,
	);
	if (bindHost !== advertiseHost) {
		pushLog(
			`[launcher] Слушаем ${bindHost} (все интерфейсы), в ссылках — ${advertiseHost}.`,
		);
	}

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
		state.warning = "";
		state.reach = null;
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
		pushLog(
			`[launcher] Процесс завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}).`,
		);
	});

	// Poll until the HTTP server answers, the child dies, or we time out.
	const waitStartedAt = Date.now();
	const deadline = waitStartedAt + READY_TIMEOUT_MS;
	let lastNoticeAt = waitStartedAt;
	let loopbackSince = 0; // first time loopback answered, 0 = never
	state.warning = "";
	state.reach = null;
	while (Date.now() < deadline) {
		if (state.child !== child) break; // stopped from under us
		const reach = await measureCurrentReach();
		if (reach.chosenOk) {
			state.reach = reach;
			state.status = "running";
			state.statusText = `Сервер работает на ${reach.dialHost}:${port}.`;
			pushLog(`[launcher] Сервер отвечает: ${guiUrlFor(reach.dialHost, port)}`);
			break;
		}
		if (reach.loopbackOk) {
			if (!loopbackSince) loopbackSince = Date.now();
			// The server is up; only the advertised address is silent. That is a
			// firewall / routing problem, not a slow start.
			if (
				!reach.loopbackOnly &&
				Date.now() - loopbackSince >= UNREACHABLE_NOTICE_MS
			) {
				state.reach = reach;
				state.status = "running";
				state.warning =
					`Сервер работает: 127.0.0.1:${port} отвечает, а ${reach.dialHost}:${port} — нет. ` +
					(firewallSupported()
						? `Обычно это брандмауэр Windows: он не пускает входящие подключения к node.exe. ` +
							`Нажмите «Разрешить порт ${port}» ниже — лончер создаст правило для всех профилей сети ` +
							`(нужны права администратора). Панель управления при этом уже доступна по 127.0.0.1.`
						: `Проверьте брандмауэр и маршрутизацию до ${reach.dialHost}.`);
				state.statusText = `Сервер работает (127.0.0.1:${port}), но ${reach.dialHost}:${port} недоступен.`;
				pushLog(`[launcher] ${state.warning}`);
				break;
			}
		} else {
			loopbackSince = 0;
		}
		if (child.exitCode !== null || child.signalCode !== null) break;
		if (spawnError) break;
		if (Date.now() - lastNoticeAt >= READY_NOTICE_MS) {
			lastNoticeAt = Date.now();
			pushLog(
				`[launcher] Ждём ответа сервера… ${Math.round((Date.now() - waitStartedAt) / 1000)} с ` +
					`(первый запуск на Windows бывает долгим)`,
			);
		}
		await delay(READY_POLL_MS);
	}

	if (state.status === "starting") {
		// Timed out (or the process vanished) without becoming ready.
		if (state.child === child) {
			await stopChild(child);
		}
		const tail = state.logs.slice(-12).join("\n");
		state.status = "error";
		state.statusText = spawnError
			? `Не удалось запустить сервер: ${spawnError.message}`
			: await startFailureReport(advertiseHost, port, bindHost, tail);
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
	state.warning = "";
	state.reach = null;
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
			sendJson(res, 500, {
				error: `Не удалось прочитать ui.html: ${err.message}`,
			});
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
		const target =
			typeof body.url === "string" && body.url ? body.url : effectiveGuiUrl();
		const ok = openUrl(target);
		sendJson(res, 200, { ok, url: target });
		return;
	}

	if (method === "POST" && pathname === "/api/reach") {
		state.reach = await measureCurrentReach();
		if (state.reach.chosenOk) state.warning = "";
		sendJson(res, 200, { reach: state.reach, warning: state.warning });
		return;
	}

	if (method === "GET" && pathname === "/api/diagnostics") {
		const result = await diagnose();
		state.reach = result.reach;
		if (result.reach.chosenOk) state.warning = "";
		sendJson(res, 200, {
			...result,
			host: state.host,
			advertiseHost: currentAdvertiseHost(),
			port: state.port,
			running: Boolean(state.child),
			platform: process.platform,
			loopbackUrl: `http://127.0.0.1:${state.port}/dashboard/`,
			networkUrl: guiUrlFor(currentAdvertiseHost(), state.port),
		});
		return;
	}

	if (method === "POST" && pathname === "/api/firewall/allow") {
		const body = await readJsonBody(req);
		const port = isValidPort(Number(body.port))
			? Number(body.port)
			: state.port;
		const result = addFirewallRule(port);
		// The rule only matters if packets now get through: re-probe and report.
		state.reach = await measureCurrentReach();
		if (result.ok && state.reach.chosenOk) state.warning = "";
		sendJson(res, 200, {
			...result,
			firewall: firewallInfo(port),
			reach: state.reach,
			warning: state.warning,
		});
		return;
	}

	if (method === "POST" && pathname === "/api/firewall/remove") {
		const body = await readJsonBody(req);
		const port = isValidPort(Number(body.port))
			? Number(body.port)
			: state.port;
		const result = removeFirewallRule(port);
		sendJson(res, 200, { ...result, firewall: firewallInfo(port) });
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

const listenPort =
	isValidPort(args.controlPort) || args.controlPort === 0
		? args.controlPort
		: 0;

controlServer.listen(listenPort, "127.0.0.1", () => {
	const actualPort = controlServer.address().port;
	const controlUrl = `http://127.0.0.1:${actualPort}`;

	// The one and only stdout line. Everything else (child output) stays in the buffer.
	process.stdout.write(`notGT launcher on ${controlUrl}\n`);

	if (args.open) {
		openUrl(`${controlUrl}/`);
	}
});
