#!/usr/bin/env node
/**
 * End-to-end test for the notGT launcher (launcher/index.mjs).
 *
 * Uses Node builtins + global fetch only. No npm dependencies.
 *
 * What it does:
 *   1. Backs up cfg/nodecg.json, seeds it with an unrelated key, starts the launcher
 *      with --no-open on an ephemeral control port, parses the printed control URL.
 *   2. Verifies /api/state interfaces + initial stopped status.
 *   3. Starts a real NodeCG instance via POST /api/start on a free port, asserts it
 *      becomes "running", the guiUrl matches, and cfg/nodecg.json got host/port while
 *      preserving the unrelated key.
 *   4. Asserts the GUI URL answers and the startup banner is in the captured logs.
 *   5. Asserts a second start is rejected with 409; stop returns to "stopped" and frees
 *      the port.
 *   6. Asserts starting on an occupied port yields status "error" with a helpful message.
 *   7. Prints PASS/FAIL per check and a final summary; exits non-zero on failure.
 *
 * The developer's own cfg/nodecg.json is restored in a finally block.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const launcherPath = path.join(repoRoot, "launcher", "index.mjs");
const cfgDir = path.join(repoRoot, "cfg");
const cfgPath = path.join(cfgDir, "nodecg.json");
const READY_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Test bookkeeping
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
// Network helpers
// ---------------------------------------------------------------------------

function isPortFree(port, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.once("listening", () => srv.close(() => resolve(true)));
		srv.listen(port, host);
	});
}

async function findFreePort(min, max) {
	for (let p = min; p <= max; p++) {
		if (await isPortFree(p)) return p;
	}
	throw new Error(`No free port in range ${min}-${max}`);
}

async function httpReq(url, options = {}, timeoutMs = 20_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...options, signal: controller.signal });
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not json */
		}
		return { status: res.status, text, json };
	} finally {
		clearTimeout(timer);
	}
}

function postJson(url, body, timeoutMs) {
	return httpReq(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		},
		timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// cfg/nodecg.json backup + restore
// ---------------------------------------------------------------------------

const cfgDirExisted = fs.existsSync(cfgDir);
const cfgExisted = fs.existsSync(cfgPath);
const cfgOriginal = cfgExisted ? fs.readFileSync(cfgPath) : null;

let seededBase = {};
if (cfgOriginal) {
	try {
		const parsed = JSON.parse(cfgOriginal.toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			seededBase = parsed;
	} catch {
		seededBase = {};
	}
}
// Unrelated keys that MUST survive the launcher's merge.
const preservedKeys = Object.keys(seededBase).filter(
	(k) => k !== "host" && k !== "port",
);
const seed = { ...seededBase, launcherTestKeep: "keep-me" };
preservedKeys.push("launcherTestKeep");

fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(seed, null, 2) + "\n", "utf8");

function restoreConfig() {
	try {
		if (cfgExisted) {
			fs.writeFileSync(cfgPath, cfgOriginal);
		} else if (fs.existsSync(cfgPath)) {
			fs.unlinkSync(cfgPath);
		}
		if (!cfgDirExisted && fs.existsSync(cfgDir)) {
			try {
				fs.rmdirSync(cfgDir);
			} catch {
				/* not empty - leave it */
			}
		}
	} catch (err) {
		console.error(`[e2e] failed to restore cfg/nodecg.json: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
// Launcher process helpers
// ---------------------------------------------------------------------------

let launcher = null;
let launcherStdout = "";
let launcherStderr = "";
let launcherExited = false;

function startLauncher() {
	return new Promise((resolve, reject) => {
		launcher = spawn(
			process.execPath,
			[launcherPath, "--app", repoRoot, "--control-port", "0", "--no-open"],
			{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		launcher.stdout.setEncoding("utf8");
		launcher.stderr.setEncoding("utf8");
		launcher.stdout.on("data", (c) => {
			launcherStdout += c;
		});
		launcher.stderr.on("data", (c) => {
			launcherStderr += c;
		});
		launcher.on("exit", (code, signal) => {
			launcherExited = true;
			if (code !== 0 && code !== null) {
				console.error(
					`[e2e] launcher exited early code=${code} signal=${signal}`,
				);
			}
		});
		launcher.on("error", reject);

		const deadline = Date.now() + CONTROL_TIMEOUT_MS;
		const poll = () => {
			const m = launcherStdout.match(
				/notGT launcher on (http:\/\/127\.0\.0\.1:(\d+))/,
			);
			if (m) {
				resolve({ url: m[1], port: Number(m[2]), raw: m[0] });
				return;
			}
			if (launcherExited) {
				reject(
					new Error(
						`launcher exited before printing its URL.\n${launcherStderr}`,
					),
				);
				return;
			}
			if (Date.now() > deadline) {
				reject(
					new Error(
						`timed out waiting for control URL.\nstdout=${launcherStdout}\nstderr=${launcherStderr}`,
					),
				);
				return;
			}
			setTimeout(poll, 100);
		};
		poll();
	});
}

async function stopLauncher() {
	if (!launcher || launcherExited) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			try {
				launcher.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			resolve();
		}, 8000);
		launcher.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		try {
			launcher.kill("SIGTERM");
		} catch {
			clearTimeout(timer);
			resolve();
		}
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	let control = null;
	let serverPort = null;
	let occupiedPort = null;
	let occupier = null;

	try {
		// -- 1. launcher boots and prints its control URL ------------------------
		control = await startLauncher();
		const stdoutLines = launcherStdout.trim().split(/\r?\n/).filter(Boolean);
		check(
			"launcher prints exactly one stdout line with the 127.0.0.1 control URL",
			stdoutLines.length === 1 &&
				/^notGT launcher on http:\/\/127\.0\.0\.1:\d+$/.test(stdoutLines[0]),
			`stdout=${JSON.stringify(launcherStdout)}`,
		);

		// -- 2. GET /api/state --------------------------------------------------
		const stateRes = await httpReq(`${control.url}/api/state`);
		const st = stateRes.json ?? {};
		const ifaces = Array.isArray(st.interfaces) ? st.interfaces : [];
		check(
			"GET /api/state returns 200 JSON",
			stateRes.status === 200,
			`status=${stateRes.status}`,
		);
		check(
			"state.interfaces is a non-empty list",
			ifaces.length > 0,
			`length=${ifaces.length}`,
		);
		const hasAll = ifaces.some(
			(i) => i.address === "0.0.0.0" || i.id === "0.0.0.0",
		);
		const hasLocal = ifaces.some(
			(i) => i.address === "127.0.0.1" || i.id === "127.0.0.1",
		);
		check("interfaces include a 0.0.0.0 entry", hasAll);
		check("interfaces include a 127.0.0.1 entry", hasLocal);
		check(
			"initial status is stopped",
			st.status === "stopped",
			`status=${st.status}`,
		);
		check(
			"state exposes node version / platform / appDir / configPath",
			!!st.nodeVersion && !!st.platform && !!st.appDir && !!st.configPath,
			JSON.stringify({
				nodeVersion: st.nodeVersion,
				platform: st.platform,
				appDir: st.appDir,
			}),
		);

		// -- 2b. UI is served, self-contained and Russian -----------------------
		const uiRes = await httpReq(`${control.url}/`);
		const uiHtml = uiRes.text || "";
		check(
			"GET / serves the launcher UI HTML with the interface/port controls",
			uiRes.status === 200 &&
				/<html/i.test(uiHtml) &&
				uiHtml.includes('id="iface"') &&
				uiHtml.includes('id="port"'),
			`status=${uiRes.status} bytes=${uiHtml.length}`,
		);
		check(
			"UI is self-contained (no external http(s) script/link/font references)",
			!/(?:src|href)\s*=\s*["']https?:\/\//i.test(uiHtml),
		);
		check(
			"UI contains the required Russian controls",
			[
				"Запустить",
				"Остановить",
				"Открыть GUI",
				"Копировать",
				"Интерфейс",
				"Порт",
			].every((s) => uiHtml.includes(s)),
		);

		// -- 3. POST /api/start -------------------------------------------------
		serverPort = await findFreePort(9095, 9199);
		console.log(
			`[e2e] starting NodeCG via launcher on 127.0.0.1:${serverPort}`,
		);
		const startRes = await postJson(
			`${control.url}/api/start`,
			{ host: "127.0.0.1", port: serverPort },
			READY_TIMEOUT_MS + 15_000,
		);
		const started = startRes.json ?? {};
		check(
			`POST /api/start reaches status "running" (${startRes.status})`,
			started.status === "running",
			`status=${started.status} statusText=${JSON.stringify(started.statusText)}`,
		);
		const expectedGuiUrl = `http://127.0.0.1:${serverPort}/dashboard/`;
		check(
			"guiUrl matches the chosen host/port",
			started.guiUrl === expectedGuiUrl,
			`guiUrl=${started.guiUrl} expected=${expectedGuiUrl}`,
		);
		check(
			"running flag is true",
			started.running === true,
			`running=${started.running}`,
		);

		// cfg/nodecg.json merged host/port and preserved unrelated keys.
		let writtenCfg = {};
		try {
			writtenCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
		} catch (err) {
			/* leave empty -> checks fail */
		}
		check(
			"cfg/nodecg.json contains the chosen host",
			writtenCfg.host === "127.0.0.1",
			`host=${writtenCfg.host}`,
		);
		check(
			"cfg/nodecg.json contains the chosen port",
			writtenCfg.port === serverPort,
			`port=${writtenCfg.port}`,
		);
		// Deep-compare so nested objects from a pre-existing developer config survive too.
		const preservedOk = preservedKeys.every((k) => {
			const expected = k === "launcherTestKeep" ? "keep-me" : seededBase[k];
			return JSON.stringify(writtenCfg[k]) === JSON.stringify(expected);
		});
		check(
			`cfg/nodecg.json preserved unrelated keys (${preservedKeys.join(", ")})`,
			preservedOk,
			`written=${JSON.stringify(writtenCfg)}`,
		);

		// -- 4. GUI answers + startup banner in logs ----------------------------
		const guiRes = await httpReq(expectedGuiUrl, { redirect: "manual" }, 8000);
		check(
			"GUI URL answers with HTTP status < 500",
			guiRes.status < 500,
			`status=${guiRes.status}`,
		);

		let bannerSeen = false;
		let logSample = "";
		const bannerDeadline = Date.now() + 8000;
		while (!bannerSeen && Date.now() < bannerDeadline) {
			const logsRes = await httpReq(`${control.url}/api/logs?since=0`);
			const lines = logsRes.json?.lines ?? [];
			logSample = lines.join("\n");
			bannerSeen = lines.some((l) => /Starting NodeCG/i.test(l));
			if (!bannerSeen) await sleep(250);
		}
		check(
			"GET /api/logs contains NodeCG's startup banner",
			bannerSeen,
			bannerSeen ? "" : `last logs:\n${logSample.slice(-800)}`,
		);
		if (bannerSeen) {
			const banner = logSample
				.split("\n")
				.find((l) => /Starting NodeCG/i.test(l));
			console.log(`      banner: ${banner.trim()}`);
		}

		// incremental logs endpoint shape
		const logsRes2 = await httpReq(`${control.url}/api/logs?since=0`);
		const next = logsRes2.json?.next;
		const logsRes3 = await httpReq(`${control.url}/api/logs?since=${next}`);
		check(
			"GET /api/logs?since=<next> returns an incremental slice",
			logsRes3.status === 200 &&
				Array.isArray(logsRes3.json?.lines) &&
				typeof logsRes3.json?.next === "number",
			JSON.stringify(logsRes3.json)?.slice(0, 200),
		);

		// -- 5. double start rejected, stop returns to stopped ------------------
		const secondStart = await postJson(
			`${control.url}/api/start`,
			{ host: "127.0.0.1", port: serverPort },
			10_000,
		);
		check(
			"second POST /api/start while running is rejected with 409",
			secondStart.status === 409,
			`status=${secondStart.status} body=${secondStart.text?.slice(0, 160)}`,
		);

		const stopRes = await postJson(`${control.url}/api/stop`, {}, 15_000);
		check(
			"POST /api/stop returns status stopped",
			stopRes.json?.status === "stopped",
			`body=${stopRes.text?.slice(0, 200)}`,
		);

		let portFreed = false;
		const freeDeadline = Date.now() + 8000;
		while (!portFreed && Date.now() < freeDeadline) {
			portFreed = await isPortFree(serverPort);
			if (!portFreed) await sleep(200);
		}
		check("port is free again after stop", portFreed);

		// -- 6. occupied port -> error ------------------------------------------
		occupiedPort = await findFreePort(9200, 9299);
		occupier = net.createServer();
		await new Promise((resolve, reject) => {
			occupier.once("error", reject);
			occupier.listen(occupiedPort, "127.0.0.1", resolve);
		});
		const busyRes = await postJson(
			`${control.url}/api/start`,
			{ host: "127.0.0.1", port: occupiedPort },
			10_000,
		);
		const busy = busyRes.json ?? {};
		check(
			"starting on an occupied port yields status error",
			busy.status === "error",
			`status=${busy.status} body=${busyRes.text?.slice(0, 200)}`,
		);
		check(
			"occupied-port error statusText is helpful (mentions the port / busy)",
			typeof busy.statusText === "string" &&
				busy.statusText.includes(String(occupiedPort)) &&
				/занят/i.test(busy.statusText),
			`statusText=${JSON.stringify(busy.statusText)}`,
		);
		check(
			"occupied-port request is a 4xx",
			busyRes.status >= 400 && busyRes.status < 500,
			`status=${busyRes.status}`,
		);

		// stop while stopped/error is a safe no-op
		const stopAgain = await postJson(`${control.url}/api/stop`, {}, 10_000);
		check(
			"POST /api/stop while not running is a safe 200 no-op",
			stopAgain.status === 200,
			`status=${stopAgain.status}`,
		);
	} finally {
		// Clean up the occupier, the launcher and the developer's config.
		if (occupier) {
			await new Promise((resolve) => occupier.close(resolve));
		}
		await stopLauncher();
		restoreConfig();
	}

	// -------------------------------------------------------------------------
	// Summary
	// -------------------------------------------------------------------------
	const failed = checks.filter((c) => !c.ok);
	console.log("");
	for (const c of checks) {
		console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
	}
	console.log("");
	if (failed.length === 0) {
		console.log(`ALL CHECKS PASSED (${checks.length}/${checks.length})`);
		return 0;
	}
	console.log(
		`${failed.length} CHECKS FAILED (${checks.length - failed.length}/${checks.length} passed)`,
	);
	return 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		console.error(`[e2e] fatal: ${err?.stack ?? err}`);
		restoreConfig();
		process.exitCode = 1;
	});
