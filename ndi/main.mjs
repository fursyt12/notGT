/**
 * notGT NDI sender — the Electron main process.
 *
 *   electron . --server http://127.0.0.1:9090 [--token <apiToken>]
 *       sends every out that has NDI switched on in the dashboard;
 *   electron . --url <page> [--name <source>] [--size 1920x1080] [--fps 30]
 *       sends one page, no server needed.
 *
 * See README.md for the flags and for running it on a Raspberry Pi.
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { app, BrowserWindow } from "electron";

import {
	Controller,
	ServerClient,
	clampFps,
	evenSize,
} from "./src/controller.mjs";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

const HELP = `notGT NDI sender ${version}

  --server <url>     notGT server (default http://127.0.0.1:9090, or NOTGT_SERVER)
  --token <key>      the senders' key, or the server's apiToken (or NOTGT_TOKEN)
  --token-file <f>   read the key from this file, again whenever it changes
                     (or NOTGT_TOKEN_FILE; what docker-compose.yml uses)
  --id <name>        how this sender is named in the dashboard (default: host name)
  --poll <ms>        how often to ask the server what to send (default 2000)

  --url <page>       send this page instead of asking a server
  --name <source>    NDI name for --url (default "notGT")
  --size <WxH>       picture size for --url (default 1920x1080)
  --scale <k>        draw the page smaller, e.g. 0.5 for 960x540 from 1920x1080
  --fps <n>          frame rate for --url (default 30)
  --groups <list>    NDI groups for --url
  --opaque           for --url: send it without transparency, over black

  --render <how>     auto (default): on the GPU where there is a usable one,
                     else on the CPU; gpu: on the GPU even if it is emulated;
                     cpu: on the CPU (or NOTGT_NDI_RENDER). --gpu and --cpu
                     are short for the last two
  --converter <c>    what turns GPU frames into NDI's: webgl (default), a
                     hidden page with WebGL2; native, the Rust addon (Vulkan,
                     Linux), with webgl after it if it cannot work
                     (or NOTGT_NDI_CONVERTER)
`;

/** The exit code that asks bin/notgt-ndi.mjs to start again on the CPU. */
export const EXIT_USE_CPU = 75;

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
		const next = argv[i + 1];
		if (inline !== undefined) args[key] = inline;
		else if (next !== undefined && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else args[key] = true;
	}
	return args;
}

const args = parseArgs(process.argv.slice(1));
if (args.help || args.h) {
	process.stdout.write(HELP);
	process.exit(0);
}

const log = (line) => process.stdout.write(`[notgt-ndi] ${line}\n`);

// --------------------------------------------------------------- chromium
const render = args.cpu
	? "cpu"
	: args.gpu
		? "gpu"
		: String(args.render || process.env.NOTGT_NDI_RENDER || "auto");
// Set before `ready`: they shape how Chromium starts.
if (render === "cpu") app.disableHardwareAcceleration();
const converter = String(
	args.converter || process.env.NOTGT_NDI_CONVERTER || "webgl",
);
const flags = app.commandLine;
flags.appendSwitch("force-device-scale-factor", "1");
flags.appendSwitch("autoplay-policy", "no-user-gesture-required");
flags.appendSwitch("disable-renderer-backgrounding");
flags.appendSwitch("disable-background-timer-throttling");
flags.appendSwitch("disable-backgrounding-occluded-windows");
flags.appendSwitch("mute-audio");
flags.appendSwitch(
	"disable-features",
	"CalculateNativeWinOcclusion,MediaSessionService,HardwareMediaKeyHandling",
);
// Nothing here overrides Chromium's own choice of GPU APIs: forcing WebGPU
// or Vulkan past its blocklist (--enable-unsafe-webgpu, Vulkan) hung the GPU
// on Linux and took the desktop down with it.
// The display and the sandbox switches have to be on the real command line:
// bin/notgt-ndi.mjs puts them there.

app.on("window-all-closed", () => {
	// Offscreen windows come and go with the outs; the sender keeps running.
});

// --------------------------------------------------------------- start
// Not a top-level await: Electron holds `ready` until the main module has run.
app
	.whenReady()
	.then(start)
	.catch((error) => {
		log(error.stack ?? String(error));
		app.exit(1);
	});

async function start() {
	const { loadNdi, NdiMissingError, REDIST_URL, discoveryProblem } =
		await import("./src/ndi.mjs");
	let discovery = discoveryProblem();
	if (discovery) log(discovery);
	const { Output } = await import("./src/output.mjs");

	let gpu = false;
	if (render === "cpu") log("drawing on the CPU");
	else {
		const found = await probeGpu();
		if (found.ok) {
			gpu = true;
			log(`drawing on the GPU: ${found.renderer}`);
		} else if (render === "auto" && process.env.NOTGT_NDI_LAUNCHER) {
			// Chromium emulating a GPU costs more than drawing on the CPU, and
			// which one it is cannot change once it runs: start again.
			log(`${found.why}: starting again on the CPU`);
			app.exit(EXIT_USE_CPU);
			return;
		} else {
			// --render gpu: on the GPU even if it is emulated, as asked.
			if (render === "gpu") gpu = true;
			log(
				`${found.why}${render === "gpu" ? "; drawing on it all the same (--render gpu)" : " — --render cpu is cheaper here"}`,
			);
		}
	}

	// The GPU converters, best first; the CPU always comes after them.
	let converters = ["webgl"];
	let native;
	if (gpu && converter === "native") {
		converters = ["native", "webgl"];
		const { loadNative, describeProbe } = await import("./src/native.mjs");
		const found = loadNative();
		// The GPU Chromium draws on — its frames are not another GPU's to
		// read: the render node on Linux, the PCI ids elsewhere.
		const renderNode = process.env.NOTGT_NDI_RENDER_NODE;
		const { vendorId, deviceId } = await chromiumGpu();
		if (vendorId)
			log(
				`Chromium draws on PCI 0x${vendorId.toString(16).padStart(4, "0")}:0x${deviceId.toString(16).padStart(4, "0")}`,
			);
		if (found.module) {
			for (const line of describeProbe(
				found.module.probe({ renderNode, vendorId, deviceId }),
			))
				log(line);
			native = { module: found.module, renderNode, vendorId, deviceId };
		} else {
			log(`${found.why}; WebGL2 converts instead`);
			native = { why: found.why };
		}
	}

	let ndi;
	let missing = "";
	/** Opens the NDI library; says why not, once per reason. */
	const tryLoad = () => {
		try {
			ndi = loadNdi();
			log(`NDI ${ndi.version} (${ndi.file})`);
			missing = "";
			return true;
		} catch (error) {
			if (error.message !== missing) {
				log(error.message);
				if (error instanceof NdiMissingError && error.details?.length) {
					for (const line of error.details) log(`  ${line}`);
				}
			}
			missing = error.message;
			return false;
		}
	};
	tryLoad();
	if (!ndi && typeof args.url === "string") {
		app.exit(2);
		return;
	}
	// Without the library the sender keeps following the server, so the
	// dashboard can say what is missing — and tries again, so installing NDI
	// is enough, without a restart.
	const missingText = () =>
		`the NDI runtime is not installed on this computer — install NDI Tools or the NDI runtime (${REDIST_URL[process.platform] ?? REDIST_URL.linux})`;

	const controller = new Controller({
		create: (config) => {
			if (!ndi && !tryLoad()) throw new Error(missingText());
			return new Output({ ndi, config, log, gpu, converters, native });
		},
		log,
	});

	let stopping = false;
	function shutdown() {
		if (stopping) return;
		stopping = true;
		controller.stopAll();
		ndi?.destroy();
		app.exit(0);
	}
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	if (typeof args.url === "string") {
		const [w, h] = String(args.size || "1920x1080")
			.split(/[x×]/)
			.map(Number);
		const designWidth = evenSize(w || 1920);
		const designHeight = evenSize(h || 1080);
		const scale = Number(args.scale) > 0 ? Math.min(1, Number(args.scale)) : 1;
		controller.apply([
			{
				id: "url",
				ndiName: typeof args.name === "string" ? args.name : "notGT",
				url: new URL(args.url).href,
				width: evenSize(designWidth * scale),
				height: evenSize(designHeight * scale),
				designWidth,
				designHeight,
				fps: clampFps(args.fps),
				alpha: !args.opaque,
				...(typeof args.groups === "string" ? { groups: args.groups } : {}),
			},
		]);
	} else {
		const server = String(
			args.server || process.env.NOTGT_SERVER || "http://127.0.0.1:9090",
		);
		const tokenFile =
			typeof args["token-file"] === "string"
				? args["token-file"]
				: process.env.NOTGT_TOKEN_FILE;
		const fixedToken =
			typeof args.token === "string" ? args.token : process.env.NOTGT_TOKEN;
		// A file is read on every request: the server rewrites it when the key
		// is replaced, and it may not be there yet when the sender starts.
		const token = tokenFile
			? () => {
					try {
						return fs.readFileSync(tokenFile, "utf8").trim() || fixedToken;
					} catch {
						return fixedToken;
					}
				}
			: fixedToken;
		const client = new ServerClient({ server, token });
		const senderId =
			typeof args.id === "string"
				? args.id
				: process.env.NOTGT_NDI_ID || os.hostname();
		const pollMs = Math.max(500, Number(args.poll) || 2000);
		let lastProblem = "";
		log(`following ${server}`);

		const tick = async () => {
			try {
				controller.apply(await client.outputs());
				// Checked every round: starting Avahi is enough, no restart.
				const now = discoveryProblem();
				if (now !== discovery)
					log(now ?? "avahi-daemon is running: receivers can find the sources");
				discovery = now;
				await client.report({
					id: senderId,
					host: os.hostname(),
					platform: `${process.platform}-${process.arch}`,
					version,
					ndi: ndi?.version ?? "",
					outs: controller
						.status()
						.map((out) =>
							discovery && !out.warning && !out.error
								? { ...out, warning: discovery }
								: out,
						),
				});
				if (lastProblem) log("the server answers again");
				lastProblem = "";
			} catch (error) {
				const problem = error.cause?.code ?? error.message;
				// The sources stay as they were while the server is away; a key
				// the server refuses (replaced in the dashboard) takes them down.
				if (error.refused) controller.apply([]);
				if (problem !== lastProblem) {
					const cause = error.cause?.code ? ` (${error.cause.code})` : "";
					log(`server ${server}: ${error.message}${cause}; trying again`);
				}
				lastProblem = problem;
			}
			if (!stopping) setTimeout(tick, pollMs);
		};
		tick();
	}
}

/** The PCI ids of the GPU Chromium draws on, where it says. */
async function chromiumGpu() {
	try {
		const info = await app.getGPUInfo("basic");
		const devices = info.gpuDevice ?? [];
		const device = devices.find((d) => d.active) ?? devices[0];
		return device?.vendorId
			? { vendorId: device.vendorId, deviceId: device.deviceId }
			: {};
	} catch {
		return {};
	}
}

/**
 * Whether Chromium draws on a GPU worth using: composited on the GPU, and
 * WebGL2 on real hardware rather than SwiftShader, llvmpipe or Windows'
 * Basic Render Driver.
 */
async function probeGpu() {
	const { isSoftwareRenderer } = await import("./src/gpu/shaders.mjs");
	// Until the GPU process has started, the status says "software".
	await app.getGPUInfo("basic").catch(() => {});
	const window = new BrowserWindow({
		show: false,
		width: 16,
		height: 16,
		webPreferences: { offscreen: true, sandbox: true },
	});
	try {
		await window.loadURL("about:blank");
		const renderer = await window.webContents.executeJavaScript(`(() => {
			const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
			if (!gl) return "";
			const info = gl.getExtension("WEBGL_debug_renderer_info");
			return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
		})()`);
		const compositing = String(app.getGPUFeatureStatus().gpu_compositing);
		if (!compositing.startsWith("enabled"))
			return {
				ok: false,
				why: `Chromium cannot use the GPU here (compositing: ${compositing})`,
			};
		if (!renderer) return { ok: false, why: "WebGL2 is not available" };
		if (isSoftwareRenderer(renderer))
			return {
				ok: false,
				renderer,
				why: `the GPU is emulated in software (${renderer})`,
			};
		return { ok: true, renderer };
	} catch (error) {
		return { ok: false, why: `the GPU could not be checked: ${error.message}` };
	} finally {
		window.destroy();
	}
}
