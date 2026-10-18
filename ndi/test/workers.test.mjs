import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, workerArgs } from "../src/supervisor.mjs";
import { EXIT_USE_CPU, WorkerOutput } from "../src/workers.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url));
const CONFIG = { id: "a", ndiName: "A", width: 1920, height: 1080 };
const until = async (check, ms = 3000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};

/** A WorkerOutput whose workers are the fake, behaving as `modes` say in turn. */
function worker(modes) {
	const started = [];
	const lines = [];
	const out = new WorkerOutput({
		config: CONFIG,
		render: "auto",
		restartMs: [50, 50],
		log: (l) => lines.push(l),
		output: () => {},
		spawn: async (config, render) => {
			started.push(render);
			const mode = modes[Math.min(started.length - 1, modes.length - 1)];
			return spawn(process.execPath, [FAKE, render], {
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { ...process.env, FAKE: mode },
			});
		},
	});
	return { out, started, lines };
}

test("a worker's own status is the out's", async () => {
	const { out } = worker(["ok"]);
	out.start();
	await until(() => out.status().state === "sending");
	assert.equal(out.status().fps, 60);
	assert.equal(out.ndiVersion, "6.3");
	await out.stop();
});

test("a worker that ends is said, with its last words, and started again", async () => {
	const { out, started, lines } = worker(["crash", "ok"]);
	out.start();
	await until(() => out.status().state === "error");
	assert.match(out.status().error, /code 1.*the page could not be drawn.*again/);
	await until(() => out.status().state === "sending");
	assert.equal(started.length, 2);
	assert.ok(lines.some((l) => /starting it again/.test(l)));
	await out.stop();
});

test("a worker whose GPU is not worth it starts again on the CPU, at once", async () => {
	assert.equal(EXIT_USE_CPU, 75);
	const { out, started } = worker(["gpu"]);
	out.start();
	await until(() => out.status().state === "sending");
	assert.deepEqual(started, ["auto", "cpu"]);
	assert.equal(out.status().render, "cpu");
	await out.stop();
});

test("stop ends the worker and is not followed by a restart", async () => {
	const { out, started } = worker(["ok"]);
	out.start();
	await until(() => out.status().state === "sending");
	const child = out.child;
	await out.stop();
	assert.notEqual(child.exitCode, null);
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(started.length, 1);
});

test("a worker never gets the server's switches, nor the key", () => {
	const argv = ["--server", "http://127.0.0.1:9090", "--token", "secret", "--id=studio", "--poll", "1000", "--converter", "native", "--one-process", "--enable-logging=stderr"];
	assert.deepEqual(workerArgs(argv), ["--converter", "native", "--enable-logging=stderr"]);
	assert.equal(parseArgs(argv).token, "secret");
});
