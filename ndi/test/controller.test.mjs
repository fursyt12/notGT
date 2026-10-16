import assert from "node:assert/strict";
import { test } from "node:test";

import {
	Controller,
	ServerClient,
	clampFps,
	configsFromServer,
	evenSize,
} from "../src/controller.mjs";

const SERVER = "http://notgt.local:9090/";

const answer = {
	outs: [
		{
			id: "main",
			name: "Main",
			ndiName: "notGT Main",
			url: "/bundles/notGT/graphics/out.html?out=main&key=out_x",
			designWidth: 1920,
			designHeight: 1080,
			width: 1280,
			height: 720,
			fps: 25,
		},
		{ id: "broken" },
	],
};

test("sizes are even and frame rates sane", () => {
	assert.equal(evenSize(1281), 1282);
	assert.equal(evenSize(0), 2);
	assert.equal(evenSize("x"), 2);
	assert.equal(clampFps(undefined), 30);
	assert.equal(clampFps(240), 60);
	assert.equal(clampFps(25), 25);
});

test("the server's answer becomes configs with absolute addresses", () => {
	const [main, ...rest] = configsFromServer(answer, SERVER);
	assert.equal(rest.length, 0, "an out without a url is skipped");
	assert.deepEqual(main, {
		id: "main",
		ndiName: "notGT Main",
		url: "http://notgt.local:9090/bundles/notGT/graphics/out.html?out=main&key=out_x",
		width: 1280,
		height: 720,
		designWidth: 1920,
		designHeight: 1080,
		fps: 25,
		alpha: true,
	});
	const [opaque] = configsFromServer(
		{ outs: [{ ...answer.outs[0], alpha: false }] },
		SERVER,
	);
	assert.equal(opaque.alpha, false);
	assert.deepEqual(configsFromServer({}, SERVER), []);
});

function fakeOutputs() {
	const log = [];
	return {
		log,
		create: (config) => {
			if (config.ndiName === "fails") throw new Error("NDI said no");
			return {
				start: () => log.push(`start ${config.id} ${config.width}`),
				stop: () => log.push(`stop ${config.id}`),
				status: () => ({ id: config.id, state: "idle" }),
			};
		},
	};
}

test("outs are started, left alone, restarted on a change and stopped when gone", () => {
	const outputs = fakeOutputs();
	const controller = new Controller({ create: outputs.create });
	const [main] = configsFromServer(answer, SERVER);

	controller.apply([main]);
	controller.apply([main]);
	assert.deepEqual(outputs.log, ["start main 1280"]);

	controller.apply([{ ...main, alpha: true }]);
	assert.equal(outputs.log.length, 1, "the same source is left alone");

	controller.apply([{ ...main, width: 960, height: 540 }]);
	assert.deepEqual(outputs.log, [
		"start main 1280",
		"stop main",
		"start main 960",
	]);

	controller.apply([]);
	assert.deepEqual(outputs.log.at(-1), "stop main");
	assert.deepEqual(controller.status(), []);
});

test("a source that cannot start is reported, not dropped", () => {
	const outputs = fakeOutputs();
	const controller = new Controller({ create: outputs.create });
	const [main] = configsFromServer(answer, SERVER);
	controller.apply([{ ...main, ndiName: "fails" }]);
	const [status] = controller.status();
	assert.equal(status.state, "error");
	assert.equal(status.error, "NDI said no");
	// Fixed in the dashboard: tried again.
	controller.apply([main]);
	assert.deepEqual(outputs.log, ["start main 1280"]);
});

test("a source that failed is tried again every round, and said once", () => {
	const lines = [];
	let broken = true;
	const controller = new Controller({
		create: (config) => {
			if (broken) throw new Error("no NDI here");
			return {
				start() {},
				stop() {},
				status: () => ({ id: config.id, state: "idle" }),
			};
		},
		log: (line) => lines.push(line),
	});
	const [main] = configsFromServer(answer, SERVER);
	controller.apply([main]);
	controller.apply([main]);
	assert.equal(lines.filter((line) => line.includes("no NDI here")).length, 1);
	broken = false;
	controller.apply([main]);
	assert.equal(controller.status()[0].state, "idle");
	assert.ok(lines.at(-1).startsWith("sending"));
});

test("the client brings the key and explains a refusal", async () => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith("/api/ndi/status"))
			return new Response(JSON.stringify({ ok: true }));
		return new Response("{}", { status: 401 });
	};
	const client = new ServerClient({
		server: "http://notgt.local:9090",
		token: "ndi_abc",
		fetch,
	});
	await assert.rejects(client.outputs(), /--token/);
	await client.report({ id: "pi" });
	assert.equal(calls[0].url, "http://notgt.local:9090/api/ndi");
	assert.equal(calls[0].init.headers.Authorization, "Bearer ndi_abc");
	assert.equal(calls[1].init.method, "POST");
	assert.equal(calls[1].init.body, JSON.stringify({ id: "pi" }));
});

test("a key given as a function is read on every request", async () => {
	const seen = [];
	let key = "";
	const fetch = async (_url, init) => {
		seen.push(init.headers.Authorization);
		return new Response(JSON.stringify({ outs: [] }));
	};
	const client = new ServerClient({
		server: "http://notgt.local:9090",
		token: () => key,
		fetch,
	});
	await client.outputs();
	key = "ndi_new";
	await client.outputs();
	assert.deepEqual(seen, [undefined, "Bearer ndi_new"]);
});
