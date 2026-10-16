#!/usr/bin/env node
/**
 * Starts the NDI sender in Electron with the switches Chromium has to see on
 * its command line — set from inside the app they come too late:
 *
 *  - `--ozone-platform=headless` on Linux, desktop or not, with a screen big
 *    enough for any out: windows are cut to the screen, and the headless one
 *    is 1×1 unless told otherwise;
 *  - `--no-sandbox` when Chromium's sandbox cannot start here: running as
 *    root, or neither the setuid helper nor user namespaces are available.
 *
 * Every argument is passed on; see `--help`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const electron = require("electron");

function read(file) {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return undefined;
	}
}

/** Whether Chromium's sandbox has something to stand on. */
function sandboxWorks() {
	if (process.getuid?.() === 0) return false;
	try {
		const helper = fs.statSync(
			path.join(path.dirname(electron), "chrome-sandbox"),
		);
		if (helper.uid === 0 && helper.mode & 0o4000) return true;
	} catch {
		// No helper: user namespaces it is.
	}
	if (read("/proc/sys/kernel/unprivileged_userns_clone") === "0") return false;
	if (read("/proc/sys/user/max_user_namespaces") === "0") return false;
	if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1")
		return false;
	return !fs.existsSync("/.dockerenv");
}

const user = process.argv.slice(2);
const env = { ...process.env };
// A file path in Electron's arguments makes it quit at once on Windows, with
// -1 and not a word (C:\… after a switch, existing or not). The key file
// goes in the environment instead, where main.mjs reads it as well.
const tokenFile = user.indexOf("--token-file");
if (tokenFile !== -1 && user[tokenFile + 1] !== undefined) {
	env.NOTGT_TOKEN_FILE = user[tokenFile + 1];
	user.splice(tokenFile, 2);
}
const chromium = [];
if (process.platform === "linux") {
	// Always, not only without a desktop: a desktop cuts windows to its screen,
	// offscreen ones included, and the sender never shows a window anyway.
	// NOTGT_NDI_DISPLAY=1 (or an --ozone-platform of one's own) keeps it.
	if (
		!process.env.NOTGT_NDI_DISPLAY &&
		!user.some((a) => a.startsWith("--ozone-platform"))
	) {
		chromium.push(
			"--ozone-platform=headless",
			"--ozone-override-screen-size=7680,4320",
		);
	}
	if (!user.includes("--no-sandbox") && !sandboxWorks())
		chromium.push("--no-sandbox");
}

// Chromium's own complaints on Linux — no D-Bus on a Pi without a desktop,
// and the like — are noise; NOTGT_NDI_DEBUG lets them through. Elsewhere
// they are what there is to read when it does not start.
if (process.platform === "linux" && !process.env.NOTGT_NDI_DEBUG) {
	chromium.push("--log-level=3");
}

const startedAt = Date.now();
const child = spawn(electron, [...chromium, appDir, ...user], {
	stdio: "inherit",
	env,
});
child.on("error", (error) => {
	process.stderr.write(
		`[notgt-ndi] Electron could not be started (${electron}): ${error.message}\n`,
	);
	process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	if (code && Date.now() - startedAt < 10_000) {
		// Gone before it could say anything itself: at least say that.
		const hex = (code >>> 0).toString(16).toUpperCase();
		process.stderr.write(
			`[notgt-ndi] Electron ended at once with code ${code} (0x${hex}); NOTGT_NDI_DEBUG=1 shows Chromium's own messages\n`,
		);
	}
	process.exitCode = code ?? (signal ? 1 : 0);
});
