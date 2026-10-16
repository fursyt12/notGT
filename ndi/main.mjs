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
import { app } from "electron";

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

  --gpu              render on the GPU (default: CPU, which is quicker for
                     offscreen rendering on most machines, the Pi included)
`;

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
// Set before `ready`: they shape how Chromium starts.
if (!args.gpu) app.disableHardwareAcceleration();
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
	const { loadNdi, NdiMissingError } = await import("./src/ndi.mjs");
	const { Output } = await import("./src/output.mjs");

	let ndi;
	try {
		ndi = loadNdi();
	} catch (error) {
		log(error.message);
		if (error instanceof NdiMissingError && error.details?.length) {
			for (const line of error.details) log(`  ${line}`);
		}
		app.exit(2);
		return;
	}
	log(`NDI ${ndi.version} (${ndi.file})`);

	const controller = new Controller({
		create: (config) => new Output({ ndi, config, log }),
		log,
	});

	let stopping = false;
	function shutdown() {
		if (stopping) return;
		stopping = true;
		controller.stopAll();
		ndi.destroy();
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
				await client.report({
					id: senderId,
					host: os.hostname(),
					platform: `${process.platform}-${process.arch}`,
					version,
					ndi: ndi.version,
					outs: controller.status(),
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
