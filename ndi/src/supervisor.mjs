/**
 * The sender as a supervisor: it follows the notGT server itself and runs
 * every out in an Electron of its own (src/workers.mjs), so each out has its
 * own Chromium GPU process and cores, and a crash costs one out, not all.
 * bin/notgt-ndi.mjs runs it for a server; `--one-process` (or
 * NOTGT_NDI_ONE_PROCESS=1) keeps every out in one Electron instead, for many
 * light outs where memory is short.
 *
 * Plain Node: no Electron, no NDI library in this process.
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import {
	Controller,
	ServerClient,
	followServer,
	tokenFrom,
} from "./controller.mjs";
import { discoveryProblem } from "./ndi.mjs";
import { WorkerOutput } from "./workers.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/** The sender's own switches, as main.mjs reads them. */
export function parseArgs(argv) {
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

/** The server's switches: the supervisor's own, never a worker's (nor its key). */
const SERVER_ONLY = ["server", "token", "token-file", "id", "poll", "one-process"];

/** `argv` without the server's switches and their values: what a worker gets. */
export function workerArgs(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const key = arg.startsWith("--") ? arg.slice(2).split("=")[0] : null;
		if (key && SERVER_ONLY.includes(key)) {
			const next = argv[i + 1];
			if (!arg.includes("=") && next !== undefined && !next.startsWith("--")) i++;
			continue;
		}
		out.push(arg);
	}
	return out;
}

/**
 * @param {object} o
 * @param {string[]} o.argv the sender's arguments
 * @param {string} o.render
 * @param {(config: object, render: string) => Promise<import("node:child_process").ChildProcess>} o.spawn
 * @param {(line: string) => void} o.say
 * @param {() => void} [o.onStop] after every worker has ended
 */
export function runSupervisor({ argv, render, spawn, say, onStop = () => {} }) {
	const args = parseArgs(argv);
	const server = String(
		args.server || process.env.NOTGT_SERVER || "http://127.0.0.1:9090",
	);
	const token = tokenFrom({
		tokenFile:
			typeof args["token-file"] === "string"
				? args["token-file"]
				: process.env.NOTGT_TOKEN_FILE,
		token: typeof args.token === "string" ? args.token : process.env.NOTGT_TOKEN,
		read: (file) => fs.readFileSync(file, "utf8"),
	});
	const controller = new Controller({
		create: (config) =>
			new WorkerOutput({
				config,
				render,
				spawn,
				log: say,
				output: (line) => process.stdout.write(`${line}\n`),
			}),
		log: say,
	});
	say(`every out in a process of its own (--one-process keeps them in one)`);
	const stopFollowing = followServer({
		client: new ServerClient({ server, token }),
		controller,
		server,
		sender: {
			id:
				typeof args.id === "string"
					? args.id
					: process.env.NOTGT_NDI_ID || os.hostname(),
			host: os.hostname(),
			platform: `${process.platform}-${process.arch}`,
			version,
		},
		ndiVersion: () =>
			[...controller.outputs.values()].map((e) => e.output?.ndiVersion).find(Boolean) ?? "",
		discoveryProblem,
		log: say,
		pollMs: Math.max(500, Number(args.poll) || 2000),
	});

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		stopFollowing();
		await Promise.all(
			[...controller.outputs.values()].map((e) => e.output?.stop()),
		);
		controller.outputs.clear();
		onStop();
		process.exit(0);
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);
	return shutdown;
}
