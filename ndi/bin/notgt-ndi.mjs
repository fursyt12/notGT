#!/usr/bin/env node
/**
 * Starts the NDI sender in Electron with the switches Chromium has to see on
 * its command line — set from inside the app they come too late:
 *
 *  - on Linux, desktop or not, a display of its own with a screen big enough
 *    for any out (windows are cut to the screen): a headless compositor on
 *    the GPU when there is one to use (see src/display.mjs), otherwise
 *    `--ozone-platform=headless`, whose screen is 1×1 unless told otherwise;
 *  - `--no-sandbox` when Chromium's sandbox cannot start here: running as
 *    root, or neither the setuid helper nor user namespaces are available.
 *
 * When the app finds the GPU unusable it ends with EXIT_USE_CPU, and is
 * started again on the CPU.
 *
 * Every `--name value` reaches Electron as `--name=value` (src/args.mjs):
 * on Windows Electron quits at once, with -1, when a switch follows anything
 * that looks like a URL — `--server http://… --render auto` did.
 *
 * Every argument is passed on; see `--help`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { electronArgs } from "../src/args.mjs";
import { startCompositor } from "../src/display.mjs";

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
/** main.mjs's EXIT_USE_CPU: the GPU is not worth it here. */
const EXIT_USE_CPU = 75;
const say = (line) => process.stdout.write(`[notgt-ndi] ${line}\n`);

// How to draw is decided here and handed on as one --render.
let render = String(process.env.NOTGT_NDI_RENDER || "auto");
for (let i = 0; i < user.length; i++) {
	if (user[i] === "--gpu" || user[i] === "--cpu") {
		render = user[i].slice(2);
		user.splice(i--, 1);
	} else if (user[i] === "--render" && user[i + 1] !== undefined) {
		render = user[i + 1];
		user.splice(i--, 2);
	} else if (user[i].startsWith("--render=")) {
		render = user[i].slice(9);
		user.splice(i--, 1);
	}
}
env.NOTGT_NDI_LAUNCHER = "1";

const common = [];
if (process.platform === "linux") {
	if (!user.includes("--no-sandbox") && !sandboxWorks())
		common.push("--no-sandbox");
	// Chromium's own complaints on Linux — no D-Bus on a Pi without a desktop,
	// and the like — are noise; NOTGT_NDI_DEBUG lets them through. Elsewhere
	// they are what there is to read when it does not start.
	if (!process.env.NOTGT_NDI_DEBUG) common.push("--log-level=3");
} else if (process.env.NOTGT_NDI_DEBUG) {
	// Windows and macOS keep Chromium's messages to themselves unless asked.
	common.push("--enable-logging=stderr");
}
/** Where Linux draws is ours to choose: not when told to keep the desktop. */
const ownDisplay =
	process.platform === "linux" &&
	!process.env.NOTGT_NDI_DISPLAY &&
	!user.some((a) => a.startsWith("--ozone-platform"));
const HEADLESS = [
	"--ozone-platform=headless",
	"--ozone-override-screen-size=7680,4320",
];

let child;
let compositor;
let stopping = false;
const startedAt = Date.now();

async function launch(how) {
	const args = [...common];
	const childEnv = { ...env };
	let mode = how;
	if (ownDisplay) {
		if (mode !== "cpu") {
			const found = await startCompositor({ env });
			if (found.ok) {
				compositor = found;
				args.push(...found.args);
				Object.assign(childEnv, found.env);
				say(`GPU: ${found.label}`);
			} else if (mode === "gpu") {
				// Asked for: the headless platform's GPU, an emulated one.
				say(`${found.why}; drawing on an emulated GPU, as --render gpu asks`);
			} else {
				// The headless platform's GPU is an emulated one: the CPU is cheaper.
				say(`${found.why}; drawing on the CPU`);
				mode = "cpu";
			}
		}
		if (!compositor) args.push(...HEADLESS);
	}
	const command = [
		...args,
		appDir,
		...electronArgs([...user, "--render", mode]),
	];
	if (process.env.NOTGT_NDI_DEBUG) say(`starting ${electron} ${command.join(" ")}`);
	child = spawn(electron, command, {
		stdio: "inherit",
		env: childEnv,
	});
	child.on("error", (error) => {
		process.stderr.write(
			`[notgt-ndi] Electron could not be started (${electron}): ${error.message}\n`,
		);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		compositor?.stop();
		compositor = undefined;
		if (code === EXIT_USE_CPU && mode !== "cpu" && !stopping) {
			launch("cpu");
			return;
		}
		if (code && Date.now() - startedAt < 10_000) {
			// Gone before it could say anything itself: at least say that.
			const hex = (code >>> 0).toString(16).toUpperCase();
			// -1 at once on Windows: Electron refused its command line, as it
			// does when a switch follows something that looks like a URL.
			const refused =
				process.platform === "win32" && code >>> 0 === 0xffffffff
					? " — Electron on Windows refuses a command line with a switch after a URL-like argument; if one was added by hand, write it as --name=value"
					: "";
			process.stderr.write(
				`[notgt-ndi] Electron ended at once with code ${code} (0x${hex})${refused}; NOTGT_NDI_DEBUG=1 shows Chromium's own messages\n`,
			);
		}
		process.exitCode = code ?? (signal ? 1 : 0);
	});
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		stopping = true;
		if (child && child.exitCode === null) child.kill(signal);
		else compositor?.stop();
	});
}
launch(render);
