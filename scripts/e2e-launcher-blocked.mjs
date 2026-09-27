#!/usr/bin/env node
/**
 * Regression test for the "бесконечная загрузка" bug report.
 *
 * Symptom (Windows, packaged launcher): the operator picks a network interface
 * other than 127.0.0.1, the browser then hangs forever, and the firewall prompt
 * was already accepted.
 *
 * Cause: binding a single network card makes Windows Firewall drop inbound
 * packets to that address - including same-machine ones. The launcher used to
 * see only "the address does not answer", which is indistinguishable from "the
 * server never started", so it waited out the full 120 s and reported failure.
 *
 * The launcher now:
 *   - binds every interface (like NodeCG's own default) unless the user chose
 *     "Только этот компьютер", so 127.0.0.1 always proves the server is alive;
 *   - notices that loopback answers while the advertised address does not,
 *     reports `running` + a warning instead of a timeout, and points the
 *     «Открыть GUI» link at 127.0.0.1 so the operator is never locked out;
 *   - offers a one-click Windows firewall rule for the port.
 *
 * On Linux this script reproduces the drop faithfully with a private network
 * namespace: a dummy card carries an address that iptables silently discards.
 * On other platforms it skips (exit 0) - there is no way to fake a silent drop
 * portably.
 *
 * Usage: node scripts/e2e-launcher-blocked.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(HERE), "..");
const launcherPath = path.join(repoRoot, "launcher", "index.mjs");
const cfgDir = path.join(repoRoot, "cfg");
const cfgPath = path.join(cfgDir, "nodecg.json");

// The address of the dummy card, and the port the iptables rules cover.
const BLOCKED_IP = "10.9.9.1";
const BLOCKED_PORT = 9595;
const CONTROL_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

const checks = [];
function check(name, ok, detail = "") {
	checks.push({ name, ok: !!ok, detail });
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`,
	);
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Emulation: re-exec inside a network namespace with a silent drop
// ---------------------------------------------------------------------------

function needsEmulation() {
	return (
		process.platform === "linux" && process.env.NOTGT_E2E_INSIDE_NETNS !== "1"
	);
}

function canEmulate() {
	if (spawnSync("unshare", ["--help"], { stdio: "ignore" }).error) return false;
	for (const tool of ["ip", "iptables"]) {
		if (spawnSync("which", [tool], { stdio: "ignore" }).status !== 0)
			return false;
	}
	return true;
}

function reexecInsideNetns() {
	const script = [
		"set -e",
		"ip link set lo up",
		"ip link add notgt0 type dummy 2>/dev/null || true",
		`ip addr add ${BLOCKED_IP}/24 dev notgt0 2>/dev/null || true`,
		"ip link set notgt0 up",
		// Drop in both directions: locally generated packets leave via OUTPUT,
		// and a connection to one of our own addresses comes back in via INPUT.
		`iptables -A OUTPUT -p tcp --dport ${BLOCKED_PORT} -d ${BLOCKED_IP} -j DROP`,
		`iptables -A INPUT -p tcp --dport ${BLOCKED_PORT} -d ${BLOCKED_IP} -j DROP`,
		`NOTGT_E2E_INSIDE_NETNS=1 exec node ${JSON.stringify(HERE)}`,
	].join("\n");
	const res = spawnSync("unshare", ["-rn", "--", "bash", "-c", script], {
		stdio: "inherit",
	});
	return res.status ?? 1;
}

// ---------------------------------------------------------------------------
// Launcher harness
// ---------------------------------------------------------------------------

let launcher = null;
let launcherStdout = "";
let cfgBackup = null;
let cfgExisted = false;

function startLauncher() {
	launcherStdout = "";
	launcher = spawn(
		process.execPath,
		[
			launcherPath,
			"--app",
			repoRoot,
			"--control-port",
			"0",
			"--no-open",
			"--host",
			BLOCKED_IP,
			"--port",
			String(BLOCKED_PORT),
		],
		{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
	launcher.stdout.setEncoding("utf8");
	launcher.stdout.on("data", (chunk) => {
		launcherStdout += chunk;
	});
	launcher.stderr.setEncoding("utf8");
	launcher.stderr.on("data", (chunk) => {
		launcherStdout += chunk;
	});
	return new Promise((resolve) => {
		const deadline = Date.now() + CONTROL_TIMEOUT_MS;
		const timer = setInterval(() => {
			const match = launcherStdout.match(/notGT launcher on (http:\/\/\S+)/);
			if (match) {
				clearInterval(timer);
				resolve(match[1].replace(/\/$/, ""));
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				resolve(null);
			}
		}, 100);
	});
}

async function stopLauncher() {
	if (!launcher) return;
	launcher.kill("SIGTERM");
	const deadline = Date.now() + 5000;
	while (launcher.exitCode === null && Date.now() < deadline) await sleep(100);
	try {
		launcher.kill("SIGKILL");
	} catch {
		/* already gone */
	}
	launcher = null;
}

function restoreConfig() {
	try {
		if (cfgExisted) fs.writeFileSync(cfgPath, cfgBackup, "utf8");
		else fs.rmSync(cfgPath, { force: true });
	} catch {
		/* best effort */
	}
}

function backupConfig() {
	cfgExisted = fs.existsSync(cfgPath);
	cfgBackup = cfgExisted ? fs.readFileSync(cfgPath, "utf8") : null;
}

async function api(base, pathname, options = {}, timeoutMs = 20_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}${pathname}`, {
			...options,
			signal: controller.signal,
		});
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text };
	} finally {
		clearTimeout(timer);
	}
}

function postJson(base, pathname, body, timeoutMs) {
	return api(
		base,
		pathname,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		},
		timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// The test itself (runs inside the namespace)
// ---------------------------------------------------------------------------

async function main() {
	let control = null;
	try {
		backupConfig();
		control = await startLauncher();
		check(
			"launcher starts and prints its control URL",
			!!control,
			launcherStdout.slice(-300),
		);
		if (!control) return 1;

		const started = await postJson(
			control,
			"/api/start",
			{ host: BLOCKED_IP, port: BLOCKED_PORT },
			START_TIMEOUT_MS,
		);
		const body = started.json ?? {};
		check(
			"server is reported as running even though the address is silent",
			body.status === "running",
			`status=${body.status} text=${JSON.stringify(body.statusText)}`,
		);
		check(
			"reach says loopback answered while the chosen address did not",
			body.reach?.loopbackOk === true && body.reach?.chosenOk === false,
			JSON.stringify(body.reach),
		);
		check(
			"a warning explains the situation",
			typeof body.warning === "string" &&
				body.warning.includes(BLOCKED_IP) &&
				body.warning.includes("127.0.0.1"),
			JSON.stringify(body.warning),
		);
		check(
			"«Открыть GUI» falls back to loopback so the operator is not locked out",
			body.guiUrl === `http://127.0.0.1:${BLOCKED_PORT}/dashboard/`,
			`guiUrl=${body.guiUrl}`,
		);
		check(
			"the network URL still names the chosen card",
			body.networkUrl === `http://${BLOCKED_IP}:${BLOCKED_PORT}/dashboard/`,
			`networkUrl=${body.networkUrl}`,
		);
		check(
			"the dashboard really is up on loopback",
			(await api(control, "/api/reach", { method: "POST" }, 20_000)).json?.reach
				?.loopbackOk === true,
		);

		const diag =
			(await api(control, "/api/diagnostics", {}, 30_000)).json ?? {};
		const warnings = (diag.verdict ?? []).filter((v) => v.level === "warn");
		check(
			"/api/diagnostics reports a warning verdict for the blocked address",
			warnings.length > 0 && warnings.some((v) => v.text.includes(BLOCKED_IP)),
			JSON.stringify(diag.verdict),
		);
		check(
			"/api/diagnostics returns fresh reach data",
			diag.reach?.chosenOk === false && diag.reach?.loopbackOk === true,
			JSON.stringify(diag.reach),
		);

		// On Windows this path opens a UAC prompt and would create a real rule,
		// so the non-Windows explanation is what gets asserted here.
		if (process.platform !== "win32") {
			const allow = (
				await postJson(control, "/api/firewall/allow", { port: BLOCKED_PORT })
			).json;
			check(
				"/api/firewall/allow explains that firewall rules are Windows-only",
				allow?.ok === false && /Windows/.test(allow?.message ?? ""),
				JSON.stringify(allow?.message),
			);
		}

		const stop = await postJson(control, "/api/stop", {}, 20_000);
		check(
			"stop clears the warning",
			stop.json?.status === "stopped" && !stop.json?.warning,
			`status=${stop.json?.status} warning=${JSON.stringify(stop.json?.warning)}`,
		);
	} finally {
		await stopLauncher();
		restoreConfig();
	}
	return checks.some((c) => !c.ok) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (needsEmulation()) {
	if (!canEmulate()) {
		console.log(
			"SKIP  the blocked-interface emulation needs Linux + unshare + ip + iptables",
		);
		process.exit(0);
	}
	console.log(
		`[e2e] re-running inside a network namespace; ${BLOCKED_IP}:${BLOCKED_PORT} is dropped\n`,
	);
	process.exit(reexecInsideNetns());
}

main()
	.then((code) => {
		const failed = checks.filter((c) => !c.ok).length;
		console.log("");
		console.log(
			failed === 0
				? `ALL CHECKS PASSED (${checks.length}/${checks.length})`
				: `${failed} CHECKS FAILED (${checks.length - failed}/${checks.length} passed)`,
		);
		process.exitCode = code;
	})
	.catch((err) => {
		console.error(`[e2e] fatal: ${err?.stack ?? err}`);
		restoreConfig();
		process.exitCode = 1;
	});
