/**
 * Where Chromium draws on Linux, decided before Electron starts.
 *
 * Chromium's own headless platform has no GPU: it emulates one in software,
 * which costs more than drawing on the CPU. What gives it the GPU without a
 * monitor is a Wayland compositor running headless on the GPU's render node
 * — sway, or weston — with a screen bigger than any out (a screen cuts
 * windows to its size, offscreen ones included). Nothing is ever shown; the
 * compositor just hands Chromium the GPU, and lets it share what it drew as
 * dmabufs. Without a render node or a compositor, it is the headless
 * platform and the CPU.
 *
 * Imported by bin/notgt-ndi.mjs; no Electron here.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Bigger than any out: 8K. */
export const SCREEN = { width: 7680, height: 4320 };

const VENDORS = {
	"0x10de": "NVIDIA",
	"0x1002": "AMD",
	"0x8086": "Intel",
};

/** The first GPU render node this user may open, or the one NOTGT_NDI_RENDER_NODE names. */
export function renderNode(env = process.env, dir = "/dev/dri") {
	if (env.NOTGT_NDI_RENDER_NODE) return env.NOTGT_NDI_RENDER_NODE;
	let names;
	try {
		names = fs.readdirSync(dir).filter((name) => /^renderD\d+$/.test(name));
	} catch {
		return undefined;
	}
	names.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
	for (const name of names) {
		const node = path.join(dir, name);
		try {
			fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK);
			return node;
		} catch {
			// Not ours to open (not in the `render` group): the next one.
		}
	}
	return undefined;
}

/** "AMD", "NVIDIA", "Intel", the kernel driver's name (v3d on a Pi), or "". */
export function gpuName(node) {
	const device = `/sys/class/drm/${path.basename(node)}/device`;
	try {
		const vendor = fs.readFileSync(`${device}/vendor`, "utf8").trim();
		if (VENDORS[vendor]) return VENDORS[vendor];
	} catch {
		// Not on PCI, as on a Pi.
	}
	try {
		const driver = /^DRIVER=(.+)$/m.exec(
			fs.readFileSync(`${device}/uevent`, "utf8"),
		);
		if (driver) return driver[1];
	} catch {
		// Nothing to say.
	}
	return "";
}

/** The full path of `command` on PATH, or undefined. */
export function which(command, env = process.env) {
	for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const file = path.join(dir, command);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return file;
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/** weston's major version, which decides how it is asked for GL. */
export function westonMajor(binary) {
	const out = spawnSync(binary, ["--version"], { encoding: "utf8" });
	const match = /weston\s+(\d+)/i.exec(`${out.stdout}${out.stderr}`);
	return match ? Number(match[1]) : 0;
}

/**
 * How to start each compositor headless on `node`: what to run, and the name
 * of the Wayland socket it makes in `runtime`.
 */
export function compositorCommand(
	name,
	binary,
	{ node, runtime, vendor, westonVersion },
) {
	if (name === "sway") {
		const config = path.join(runtime, "sway.conf");
		fs.writeFileSync(
			config,
			`output HEADLESS-1 mode ${SCREEN.width}x${SCREEN.height}\nxwayland disable\n`,
		);
		return {
			command: binary,
			// sway refuses NVIDIA's own driver unless told it is wanted.
			args: [
				"-c",
				config,
				...(vendor === "NVIDIA" ? ["--unsupported-gpu"] : []),
			],
			env: {
				WLR_BACKENDS: "headless",
				WLR_RENDER_DRM_DEVICE: node,
				WLR_LIBINPUT_NO_DEVICES: "1",
			},
			socket: undefined,
		};
	}
	const socket = "notgt-ndi";
	return {
		command: binary,
		args: [
			westonVersion >= 11
				? "--backend=headless"
				: "--backend=headless-backend.so",
			westonVersion >= 12 ? "--renderer=gl" : "--use-gl",
			`--width=${SCREEN.width}`,
			`--height=${SCREEN.height}`,
			"--idle-time=0",
			"--no-config",
			`--socket=${socket}`,
		],
		env: {},
		socket,
	};
}

/**
 * A headless compositor on the GPU, ready for Chromium; or why there is none.
 * @returns {Promise<{ ok: true, label: string, args: string[], env: object, stop: () => void } | { ok: false, why: string }>}
 */
export async function startCompositor({
	env = process.env,
	log = () => {},
} = {}) {
	const node = renderNode(env);
	if (!node)
		return {
			ok: false,
			why: "no GPU this user may use (no /dev/dri/renderD*, or not in its group)",
		};
	const vendor = gpuName(node);
	const root = process.getuid?.() === 0;
	const choices = [];
	const sway = which("sway", env);
	const weston = which("weston", env);
	// sway will not run as root (as in a container); weston will.
	if (sway && !root) choices.push(["sway", sway]);
	if (weston) choices.push(["weston", weston]);
	if (!choices.length)
		return {
			ok: false,
			why: `the GPU (${vendor || node}) needs a headless Wayland compositor to draw without a display: install sway${root ? " and run as a user other than root, or weston" : " or weston"}`,
		};

	const problems = [];
	for (const [name, binary] of choices) {
		const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-ndi-"));
		fs.chmodSync(runtime, 0o700);
		const plan = compositorCommand(name, binary, {
			node,
			runtime,
			vendor,
			westonVersion: name === "weston" ? westonMajor(binary) : 0,
		});
		const logFile = path.join(runtime, `${name}.log`);
		const out = fs.openSync(logFile, "w");
		const childEnv = { ...env, ...plan.env, XDG_RUNTIME_DIR: runtime };
		delete childEnv.WAYLAND_DISPLAY;
		delete childEnv.DISPLAY;
		const child = spawn(plan.command, plan.args, {
			env: childEnv,
			stdio: ["ignore", out, out],
		});
		fs.closeSync(out);
		let exited = false;
		child.on("exit", () => {
			exited = true;
		});
		child.on("error", () => {
			exited = true;
		});
		const socket = await waitForSocket(runtime, plan.socket, () => exited);
		const stop = () => {
			if (!exited) child.kill("SIGTERM");
			fs.rmSync(runtime, { recursive: true, force: true });
		};
		if (socket) {
			log(`${name} on ${node}${vendor ? ` (${vendor})` : ""}`);
			return {
				ok: true,
				label: `${vendor || "GPU"} at ${node}, through a headless ${name}`,
				args: ["--ozone-platform=wayland"],
				// The node is for the native converter: the same GPU as Chromium.
				env: {
					XDG_RUNTIME_DIR: runtime,
					WAYLAND_DISPLAY: socket,
					NOTGT_NDI_RENDER_NODE: node,
				},
				stop,
			};
		}
		let tail = "";
		try {
			tail = fs
				.readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.slice(-2)
				.join(" / ");
		} catch {
			// No log.
		}
		problems.push(`${name} did not start${tail ? `: ${tail}` : ""}`);
		stop();
	}
	return { ok: false, why: problems.join("; ") };
}

async function waitForSocket(runtime, name, gone) {
	for (let i = 0; i < 50; i++) {
		const found = fs
			.readdirSync(runtime)
			.find((file) => (name ? file === name : /^wayland-\d+$/.test(file)));
		if (found) return found;
		if (gone()) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return undefined;
}
