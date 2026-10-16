#!/usr/bin/env node
/**
 * Starts the NDI sender in Electron with the switches Chromium has to see on
 * its command line — set from inside the app they come too late:
 *
 *  - `--ozone-platform=headless` when Linux has no display (a Pi without a
 *    desktop, a server, a container), with a screen big enough for any out:
 *    the headless screen is 1×1 and windows are cut to the screen;
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
const chromium = [];
if (process.platform === "linux") {
	if (
		!process.env.DISPLAY &&
		!process.env.WAYLAND_DISPLAY &&
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

// Chromium's own complaints — no D-Bus on a Pi without a desktop, and the
// like — are noise here; NOTGT_NDI_DEBUG lets them through.
if (!process.env.NOTGT_NDI_DEBUG) chromium.push("--log-level=3");

const child = spawn(electron, [...chromium, appDir, ...user], {
	stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
