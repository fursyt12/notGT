#!/usr/bin/env node
/**
 * notGT end-to-end test of the timers.
 *
 * Checks, against a running server:
 *   1. a timer is made, read, renamed, given a duplicate key (refused) and
 *      removed over REST, and is listed in `GET /api/state`;
 *   2. start · pause · adjust · set · reset · toggle do what they say, on the
 *      server's clock, and a countdown that reaches zero is stopped by the
 *      server (`running: false`, `done: true`);
 *   3. two titles read the same timer — a `layers` one through a bound text
 *      layer, a `code` one through `data-bind` and `timer()` — and both tick
 *      on the out page while it runs and stand still while it is paused;
 *   4. the WebSocket: `getTimers`, the `timer` verb, and the `timers` topic,
 *      which pushes what a timer shows as it changes;
 *   5. sharing, when the team can be managed without signing in: the key of a
 *      group reaches the timers shared with that group or with everyone, and
 *      no others; it can share one with another group too, but not give it
 *      away altogether.
 *
 * Usage (server must already be running):
 *   node scripts/e2e-timers.mjs
 *
 *   NOTGT_BASE   http://127.0.0.1:9090
 *   NOTGT_TOKEN  the `apiToken`, when one is set
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", ".e2e");
const BASE = process.env.NOTGT_BASE ?? "http://127.0.0.1:9090";
const TOKEN = process.env.NOTGT_TOKEN ?? "";
const CHROME =
	process.env.CHROME_PATH ??
	["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));

const KEY = "e2e-match";
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

async function api(method, url, body, { allowError = false } = {}) {
	const response = await fetch(`${BASE}${url}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!response.ok && !allowError) throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
	return allowError ? { status: response.status, body: json } : json;
}

const timer = (command, body) => api("POST", `/api/timers/${KEY}/${command}`, body);

/** A code title that reads the timer twice: a bound element, and `timer()` in `onData`. */
const CODE = {
	html: `<div id="face" data-bind="timer.${KEY}.text"></div><div id="secs"></div>`,
	css: "#face,#secs{font:700 80px sans-serif;color:#fff}",
	js: `onData(function(){ document.getElementById("secs").textContent = timer("${KEY}", "ss"); });`,
};

async function cleanup(outId) {
	await api("DELETE", `/api/timers/${KEY}`, undefined, { allowError: true });
	for (const id of ["e2e-timer-layers", "e2e-timer-code"]) {
		await api("DELETE", `/api/templates/${id}`, undefined, { allowError: true });
	}
	if (outId) {
		const out = await api("GET", `/api/outs/${outId}`, undefined, { allowError: true });
		for (const item of out.body?.out?.items ?? out.body?.items ?? []) {
			if (String(item.templateId).startsWith("e2e-timer")) {
				await api("DELETE", `/api/outs/${outId}/items/${item.id}`, undefined, { allowError: true });
			}
		}
	}
}

/** A WebSocket that keeps every frame and can wait for one. */
function connect(key = TOKEN) {
	const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws${key ? `?token=${encodeURIComponent(key)}` : ""}`);
	const frames = [];
	const waiters = new Set();
	let nextId = 1;
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		frames.push(frame);
		for (const waiter of [...waiters]) {
			if (waiter.match(frame)) {
				waiters.delete(waiter);
				waiter.resolve(frame);
			}
		}
	});
	return {
		socket,
		frames,
		opened: new Promise((resolve, reject) => {
			socket.on("open", resolve);
			socket.on("error", reject);
		}),
		wait(match, label, timeoutMs = 4000, from = 0) {
			const seen = frames.slice(from).find(match);
			if (seen) return Promise.resolve(seen);
			return new Promise((resolve, reject) => {
				const waiter = { match, resolve };
				waiters.add(waiter);
				setTimeout(() => {
					if (waiters.delete(waiter)) reject(new Error(`timed out waiting for ${label}`));
				}, timeoutMs);
			});
		},
		send(type, params = {}) {
			const id = nextId++;
			socket.send(JSON.stringify({ type, id, ...params }));
			return this.wait((frame) => frame.type === "reply" && frame.id === id, `reply to ${type}`);
		},
	};
}

const TEAM = "/bundles/notGT/team";

/** Two groups, a timer for each, and what the key of the first one reaches. */
async function sharing() {
	const probe = await api("POST", `${TEAM}/groups`, { name: "E2E VJ" }, { allowError: true });
	if (probe.status !== 201) {
		console.log(`SKIP  sharing — the team needs a signed-in administrator here (${probe.status})`);
		return;
	}
	const vj = probe.body.group;
	const stream = (await api("POST", `${TEAM}/groups`, { name: "E2E Stream" })).group;
	const key = (await api("POST", `${TEAM}/groups/${vj.id}/keys`, { label: "e2e" })).group.keys[0].key;
	try {
		await api("POST", "/api/timers", { name: "E2E VJ", key: "e2e-vj", groups: [vj.id] });
		await api("POST", "/api/timers", { name: "E2E Stream", key: "e2e-stream", groups: [stream.id] });

		const ws = connect(key);
		await ws.opened;
		await ws.wait((frame) => frame.type === "hello", "hello");
		const keys = (await ws.send("getTimers")).result.timers.map((entry) => entry.key);
		check("a group's key sees its own timers and everyone's", keys.includes("e2e-vj") && keys.includes(KEY), keys.join(","));
		check("but not another group's", !keys.includes("e2e-stream"), keys.join(","));
		const state = (await ws.send("getState")).result.state;
		check("its state lists the same timers", !(state.timers ?? []).some((entry) => entry.key === "e2e-stream"));
		const foreign = await ws.send("timer", { action: "start", timer: "e2e-stream" });
		check("it cannot drive another group's timer", !foreign.ok && foreign.error?.code === "forbidden", JSON.stringify(foreign.error));
		const shared = await ws.send("timer", { action: "update", timer: "e2e-vj", groups: [vj.id, stream.id] });
		check("it shares its timer with another group", shared.ok && shared.result.timer.groups.length === 2);
		const away = await ws.send("timer", { action: "update", timer: "e2e-vj", groups: [stream.id] });
		check("but cannot give it away altogether", !away.ok && away.error?.code === "forbidden");
		const made = await ws.send("timer", { action: "create", name: "E2E made by VJ", key: "e2e-made" });
		check("a timer it makes is shared with its group", made.ok && made.result.timer.groups.join() === vj.id);
		ws.socket.close();

		const streamTimer = (await api("GET", "/api/timers/e2e-vj")).timer;
		check("the other group now has it too", streamTimer.groups.includes(stream.id));
	} finally {
		for (const ref of ["e2e-vj", "e2e-stream", "e2e-made"]) {
			await api("DELETE", `/api/timers/${ref}`, undefined, { allowError: true });
		}
		await api("DELETE", `${TEAM}/groups/${vj.id}`, undefined, { allowError: true });
		await api("DELETE", `${TEAM}/groups/${stream.id}`, undefined, { allowError: true });
	}
}

async function main() {
	if (!CHROME) throw new Error("No Chromium binary found; set CHROME_PATH");
	fs.mkdirSync(outDir, { recursive: true });
	const outs = await api("GET", "/api/outs");
	const outId = outs.outs[0]?.id;
	if (!outId) throw new Error("The server has no out");
	await cleanup(outId);

	// ------------------------------------------------------------------ REST
	const created = await api("POST", "/api/timers", { name: "E2E match", key: KEY, duration: "0:05" });
	check("create: the key it was given", created.timer?.key === KEY, created.timer?.key);
	check("create: a countdown reads its duration", created.timer?.vars?.text === "00:05", created.timer?.vars?.text);
	const dup = await api("POST", "/api/timers", { name: "Dup", key: KEY }, { allowError: true });
	check("create: a key that is taken is refused", dup.status === 400, String(dup.status));
	const renamed = await api("PATCH", `/api/timers/${KEY}`, { name: "E2E match!" });
	check("update: renamed", renamed.timer?.name === "E2E match!");
	const state = await api("GET", "/api/state");
	check("state lists the timer", (state.timers ?? []).some((entry) => entry.key === KEY));
	const unknown = await api("POST", "/api/timers/nope/start", {}, { allowError: true });
	check("an unknown timer is a 404", unknown.status === 404, String(unknown.status));

	// --------------------------------------------- two titles, one timer
	await api("POST", "/api/templates", {
		id: "e2e-timer-layers",
		name: "E2E timer (layers)",
		kind: "layers",
		width: 1920,
		height: 1080,
		layers: [
			{
				id: "t_face",
				type: "text",
				x: 5,
				y: 5,
				width: 30,
				binding: `timer.${KEY}.text`,
				text: "--",
				style: { fontSize: 96, color: "#ffffff", tabularNums: true, opacity: 1, rotation: 0 },
				z: 1,
			},
		],
	});
	await api("POST", "/api/templates", {
		id: "e2e-timer-code",
		name: "E2E timer (code)",
		kind: "code",
		width: 800,
		height: 300,
		code: CODE,
	});
	await api("POST", `/api/outs/${outId}/items`, { templateId: "e2e-timer-layers", held: true });
	await api("POST", `/api/outs/${outId}/items`, { templateId: "e2e-timer-code", held: true, y: 50 });

	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		const errors = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.goto(`${BASE}/bundles/notGT/graphics/out.html?out=${outId}${TOKEN ? `&key=${TOKEN}` : ""}`, {
			waitUntil: "networkidle0",
		});
		const read = () =>
			page.evaluate(() => {
				const layer = document.querySelector('[data-layer-id="t_face"]');
				const frame = [...document.querySelectorAll("iframe.notgt-code-frame")][0];
				const doc = frame?.contentDocument;
				return {
					layer: layer?.textContent ?? null,
					tabular: layer ? getComputedStyle(layer).fontVariantNumeric : null,
					face: doc?.getElementById("face")?.textContent ?? null,
					secs: doc?.getElementById("secs")?.textContent ?? null,
				};
			});
		await page.waitForFunction(
			() => document.querySelector('[data-layer-id="t_face"]')?.textContent === "00:05",
			{ timeout: 5000 },
		).catch(() => {});
		let seen = await read();
		check("layers title shows the timer", seen.layer === "00:05", JSON.stringify(seen));
		check("its digits are all one width", seen.tabular === "tabular-nums", seen.tabular);
		check("code title shows it through data-bind", seen.face === "00:05", seen.face);
		check("code title reads it with timer()", seen.secs === "05", seen.secs);

		// A minute to spare: what is checked here is that it moves.
		await timer("set", { value: "1:00" });
		await timer("start");
		await sleep(2300);
		seen = await read();
		check("running: the layer ticks", /^00:5[78]$/.test(seen.layer ?? ""), seen.layer);
		check("running: the code title ticks with it", seen.face === seen.layer, `${seen.face} vs ${seen.layer}`);

		await timer("pause");
		const paused = await read();
		await sleep(1300);
		seen = await read();
		check("paused: it stands still", seen.layer === paused.layer, `${paused.layer} -> ${seen.layer}`);

		await timer("adjust", { delta: 10 });
		await sleep(400);
		seen = await read();
		check("adjust +10 s adds to what it shows", seen.layer === `01:0${Number(paused.layer.slice(3)) + 10 - 60}`, `${paused.layer} -> ${seen.layer}`);

		await timer("set", { value: "2:00" });
		await sleep(400);
		check("set 2:00", (await read()).layer === "02:00");

		await api("PATCH", `/api/timers/${KEY}`, { format: "ss" });
		await sleep(400);
		check("format: whole seconds", (await read()).layer === "120");
		await api("PATCH", `/api/timers/${KEY}`, { format: "auto" });

		await timer("reset");
		await sleep(400);
		check("reset: back to the duration", (await read()).layer === "00:05");
		await page.screenshot({ path: path.join(outDir, "timers-out.png") });

		check("no errors on the out page", errors.length === 0, errors.join("; "));
	} finally {
		await browser.close();
	}

	// ------------------------------------------------- the end of a countdown
	await timer("set", { value: "0:01" });
	const started = await timer("start");
	check("start: running", started.timer?.running === true);
	await sleep(1600);
	const ended = await api("GET", `/api/timers/${KEY}`);
	check("at zero the server stops it", ended.timer?.running === false, JSON.stringify(ended.timer?.vars));
	check("and it reads done at 00:00", ended.timer?.vars?.done === true && ended.timer?.vars?.text === "00:00");
	const again = await timer("toggle");
	check("starting a finished countdown starts it over", again.timer?.running === true && again.timer?.elapsedMs === 0);
	await timer("reset");

	// ------------------------------------------------------------ WebSocket
	const ws = connect();
	await ws.opened;
	await ws.wait((frame) => frame.type === "hello", "hello");
	const list = await ws.send("getTimers");
	check("ws getTimers", list.ok && list.result.timers.some((entry) => entry.key === KEY));
	const sub = await ws.send("subscribe", { topics: ["timers"] });
	check("ws subscribe timers", sub.ok, JSON.stringify(sub.error ?? ""));
	const first = await ws.wait((frame) => frame.type === "timers", "timers frame");
	const mine = first.timers.find((entry) => entry.key === KEY);
	check("timers frame carries the text", mine?.text === "00:05", JSON.stringify(mine));
	const mark = ws.frames.length;
	const toggled = await ws.send("timer", { action: "toggle", timer: KEY });
	check("ws timer toggle starts it", toggled.ok && toggled.result.timer.running === true);
	const ticked = await ws.wait(
		(frame) => frame.type === "timers" && frame.timers.some((entry) => entry.key === KEY && entry.text === "00:04"),
		"a tick in the timers topic",
		3000,
		mark,
	).catch(() => undefined);
	check("the timers topic pushes the ticks", Boolean(ticked));
	const bad = await ws.send("timer", { action: "explode", timer: KEY });
	check("ws: an unknown action is refused", !bad.ok && bad.error?.code === "bad_request");
	ws.socket.close();

	// ------------------------------------------------------------- sharing
	await sharing();

	// ------------------------------------------------------------- removal
	const removed = await api("DELETE", `/api/timers/${KEY}`);
	check("remove", removed.id === created.timer.id);
	await cleanup(outId);

	if (failures.length) {
		console.log(`\n${failures.length} check(s) failed`);
		process.exit(1);
	}
	console.log("\nAll timer checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
