#!/usr/bin/env node
/**
 * Measures the NDI sender end to end on this machine, through real NDI
 * receivers: what it costs (CPU per process, the compositor included; GPU;
 * memory), what comes out (frame rate, fresh frames, latency) and whether it
 * is right (known colours and alpha, checked in what the receiver gets).
 *
 *   node scripts/bench.mjs [--render auto|gpu|cpu] [--page still|lower|full|heavy|entry]
 *        [--outs 1] [--size 1920x1080] [--fps 30] [--seconds 10] [--opaque]
 *        [--ips 127.0.0.1] [--json] [--log] [--every 60] [--period 2500] [--shows 40]
 *
 * It plays the notGT server itself (the outs, the page: test/fixtures/
 * bench.html), starts bin/notgt-ndi.mjs as anyone would, and receives every
 * source in a worker thread of its own. The receivers' own work is not
 * counted. Needs the NDI library, as the sender does.
 *
 * What comes out is read from the page's own marks (bench.html says how):
 * frames the page drew that never arrived, the gaps between new ones, and
 * with `--page entry` every show — whether it arrived from its frame 0, and
 * which of its frames are missing, both as script draws a show and as the
 * compositor moves one. `--shows <n>`: measure that many shows, `--period`
 * ms apart. The sender's own counts (src/telemetry.mjs) are set beside them:
 * where on its way a frame was lost.
 *
 *   node scripts/bench.mjs --real http://notgt:9090 [--token <apiToken>] [--out <id>] --shows 40 …
 *
 * `--real`: the same shows, through a real notGT server — its out page, with
 * a code title that draws the count as #entry does (a fresh iframe each
 * show, as notGT puts code titles), shown and hidden over its API as an
 * operator would. The title is the server's only for the run.
 *
 * `--connect 0,250,500,1000` (with `--real`): no receiver between shows; one
 * connects that many ms into each show in turn, and the bench says how soon
 * the show's frame of the moment arrived, which frame that was, and what
 * was missing after it — whether a receiver that connects late gets the out
 * as it is.
 *
 * `--every <s>`: one long run, reported every <s> seconds for --seconds in
 * all — a JSON line a window with --json — to see what changes over time
 * (memory that grows, a rate that drifts, a picture that breaks).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	Worker,
	isMainThread,
	parentPort,
	workerData,
} from "node:worker_threads";
import { percentiles } from "../src/telemetry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** The patches of bench.html, straight RGBA, in order. */
const PATCHES = [
	[255, 0, 0, 255],
	[0, 255, 0, 255],
	[0, 0, 255, 255],
	[255, 255, 255, 255],
	[128, 128, 128, 255],
	[32, 32, 32, 255],
	[255, 128, 0, 255],
	[255, 255, 255, 128],
	[255, 0, 0, 64],
	[0, 0, 255, 191],
	[0, 0, 0, 128],
];
/**
 * What NDI may change, in 0–255. Its own BGRA path brings pure blue back as
 * 240: studio-range 4:2:2 and compression, before anything of ours.
 */
const TOLERANCE = { colour: 16, alpha: 4 };
const STAMP_WRAP = 2 ** 24;
/** --real: the code title the shows are made of. */
const TITLE_ID = "notgt-bench-count";
/** Frames in a show of bench.html#entry, and how many count as its start. */
const SHOW_FRAMES = 60;
const SHOW_START = 30;

/** The first source's number (--first). */
let firstSource = 1;

if (isMainThread) await main();
else await receive(workerData);

// ------------------------------------------------------------- the bench
async function main() {
	const args = parseArgs(process.argv.slice(2));
	const [width, height] = String(args.size ?? "1920x1080")
		.split(/[x×]/)
		.map(Number);
	const options = {
		render: String(args.render ?? "auto"),
		page: String(args.page ?? "lower"),
		outs: Math.max(1, Number(args.outs) || 1),
		width,
		height,
		fps: Number(args.fps) || 30,
		// #entry: a show every `period` ms.
		period: Number(args.period) || 2500,
		seconds:
			Number(args.seconds) ||
			(args.shows ? Math.ceil((Number(args.shows) * (Number(args.period) || 2500)) / 1000) : 10),
		alpha: !args.opaque,
		ips: typeof args.ips === "string" ? args.ips : "127.0.0.1",
		every: Number(args.every) || 0,
		// --first <n>: number the sources from n, for several benches at once.
		first: Math.max(1, Number(args.first) || 1),
		real: typeof args.real === "string" ? args.real.replace(/\/$/, "") : "",
		// --connect: a receiver joins each show this many ms in, in turn.
		connect:
			typeof args.connect === "string"
				? args.connect.split(",").map(Number).filter((ms) => ms >= 0)
				: [],
	};
	// --real: shows of a code title on a real server's out page.
	const real = options.real ? await realShows(options, args) : undefined;
	if (real) options.page = "entry";
	if (options.connect.length && !real) {
		console.error("--connect needs --real: the bench has to start the shows itself");
		process.exit(1);
	}
	firstSource = options.first;
	const say = args.json ? () => {} : (line) => console.log(line);

	const gpuBefore = gpuMemory();
	const server = await serve({ ...options, url: real?.url });
	say(
		`${options.outs} × ${width}×${height} @ ${options.fps} fps, #${options.page}, ${options.alpha ? "alpha" : "opaque"}, --render ${options.render}`,
	);
	const sender = spawn(
		process.execPath,
		[
			path.join(root, "bin", "notgt-ndi.mjs"),
			"--server",
			`http://127.0.0.1:${server.port}`,
			"--id",
			"bench",
			"--poll",
			"1000",
			"--render",
			options.render,
		],
		{ cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
	);
	const senderLog = [];
	/** Everything the sender and its Electron said, for when it does not start. */
	const rawLog = [];
	for (const stream of [sender.stdout, sender.stderr]) {
		stream.setEncoding("utf8");
		let partial = "";
		stream.on("data", (chunk) => {
			const lines = (partial + chunk).split(/\r?\n/);
			partial = lines.pop();
			for (const line of lines) {
				if (!line) continue;
				rawLog.push(line);
				if (rawLog.length > 500) rawLog.shift();
				if (line.startsWith("[notgt-ndi]")) senderLog.push(line.slice(12));
				// --log: all of it, Chromium's own messages included.
				if (args.log) console.error(line);
			}
		});
	}
	const stopSender = () => {
		if (sender.exitCode === null) sender.kill("SIGTERM");
	};
	process.on("exit", stopSender);
	process.on("SIGINT", () => process.exit(130));

	// One receiver per source, each in its own thread. flag[0]: 0 settling,
	// 1 measuring, 2 done; flag[1]: the window being measured (--every);
	// --connect: flag[2] 1 while a receiver is to be connected, flag[3] the
	// show it joins.
	const flag = new Int32Array(new SharedArrayBuffer(16));
	const windowResults = new Map();
	const workers = Array.from({ length: options.outs }, (_, i) => {
		const worker = new Worker(fileURLToPath(import.meta.url), {
			workerData: {
				name: sourceName(i),
				ips: options.ips,
				width,
				height,
				alpha: options.alpha,
				// A real out page has none of bench.html's colour patches.
				patches: !real,
				connect: options.connect,
				flag,
			},
		});
		return new Promise((resolve, reject) => {
			worker.on("message", (message) => {
				if (message.connected) say(`  receiving ${message.connected}`);
				if (message.window !== undefined) {
					const list = windowResults.get(message.window) ?? [];
					list.push(message.windowResult);
					windowResults.set(message.window, list);
				} else if (message.result) resolve(message.result);
			});
			worker.on("error", reject);
		});
	});
	const sending = await server.untilSending(options.outs, 60_000);
	if (!sending) {
		console.error(
			`The sender did not start sending in time${sender.exitCode !== null ? ` (it ended with code ${sender.exitCode})` : ""}. It said:\n${rawLog.join("\n")}`,
		);
		process.exit(1);
	}
	// Let it settle: first frames, receivers connected, painting at the full rate.
	await sleep(5000);
	real?.start({
		shown: (n) => {
			if (!options.connect.length) return;
			setTimeout(() => {
				Atomics.store(flag, 3, n);
				Atomics.store(flag, 2, 1);
				Atomics.notify(flag, 2);
			}, options.connect.at((n - 1) % options.connect.length));
		},
		hidden: () => Atomics.store(flag, 2, 0),
	});
	if (options.every) {
		await everyWindow({ options, sender, server, flag, windowResults, args, say });
		Atomics.store(flag, 0, 2);
		await Promise.all(workers);
		await real?.stop();
		stopSender();
		server.close();
		process.exit(0);
	}

	const sampler = sampleGpu(options.seconds);
	const before = processTree(sender.pid);
	const countedBefore = pipelines(server.lastStatus());
	Atomics.store(flag, 0, 1);
	const started = performance.now();
	await sleep(options.seconds * 1000);
	Atomics.store(flag, 0, 2);
	const elapsed = (performance.now() - started) / 1000;
	const after = processTree(sender.pid);
	const gpu = await sampler;
	const gpuAfter = gpuMemory();
	const results = await Promise.all(workers);
	const status = server.lastStatus();
	await real?.stop();
	stopSender();
	server.close();

	const report = {
		machine: machine(),
		options,
		render: [...new Set((status?.outs ?? []).map((out) => out.render))].join(
			"+",
		),
		adapter: status?.outs?.find((out) => out.adapter)?.adapter ?? "",
		// The status comes every second or two: a little of before and after is in it.
		pipeline: grown(countedBefore, pipelines(status)),
		senderSays: senderLog.filter((line) =>
			/GPU:|drawing on|instead|cannot|emulated/.test(line),
		),
		cpu: cpuUse(before, after, elapsed),
		gpu: {
			...gpu,
			...(gpuAfter && gpuBefore
				? {
						vramMB: Math.round((gpuAfter.vram - gpuBefore.vram) / 2 ** 20),
						gttMB: Math.round((gpuAfter.gtt - gpuBefore.gtt) / 2 ** 20),
					}
				: {}),
		},
		receivers: results,
	};
	if (args.json) console.log(JSON.stringify(report));
	else printReport(report);
	process.exit(0);
}

function sourceName(i) {
	return `notGT bench ${i + firstSource}`;
}

/** The notGT server, as far as the sender needs one. */
function serve({ outs, width, height, fps, alpha, page, period, url: pageUrl }) {
	const html = fs.readFileSync(
		path.join(root, "test", "fixtures", "bench.html"),
	);
	let status;
	const waiting = [];
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://localhost");
		if (url.pathname === "/api/ndi") {
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					outs: Array.from({ length: outs }, (_, i) => ({
						id: `bench${i + 1}`,
						ndiName: sourceName(i),
						url: pageUrl ?? `/bench.html?fps=${fps}&period=${period}#${page}`,
						width,
						height,
						designWidth: 1920,
						designHeight: 1080,
						fps,
						alpha,
					})),
				}),
			);
		} else if (url.pathname === "/api/ndi/status") {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				try {
					status = JSON.parse(body);
				} catch {
					// Keep the last one.
				}
				for (const check of waiting) check();
				response.end("{}");
			});
		} else if (url.pathname === "/bench.html") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(html);
		} else {
			response.statusCode = 404;
			response.end();
		}
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				port: server.address().port,
				lastStatus: () => status,
				close: () => server.close(),
				untilSending: (count, timeoutMs) =>
					new Promise((done) => {
						const timer = setTimeout(() => done(false), timeoutMs);
						waiting.push(() => {
							const outs = (status?.outs ?? []).filter(
								(out) => out.state === "sending" && out.connections > 0,
							);
							if (outs.length >= count) {
								clearTimeout(timer);
								done(true);
							}
						});
					}),
			}),
		),
	);
}

/**
 * --real: shows through a real notGT server. Its out page is the one sent;
 * every `period` ms a code title that draws the count is shown on it over
 * the API, and hidden again once its frames are drawn. `stop()` takes the
 * title away again.
 */
async function realShows(options, args) {
	const base = options.real;
	const token = typeof args.token === "string" ? args.token : (process.env.NOTGT_TOKEN ?? "");
	const api = async (method, url, body) => {
		const response = await fetch(`${base}/api${url}`, {
			method,
			headers: {
				...(body ? { "content-type": "application/json" } : {}),
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) throw new Error(`${method} ${base}/api${url}: ${response.status} ${await response.text()}`);
		return response.json();
	};
	const outs = (await api("GET", "/outs")).outs ?? [];
	const out = typeof args.out === "string" ? outs.find((o) => o.id === args.out) : outs[0];
	if (!out) throw new Error(`${base} has no out${typeof args.out === "string" ? ` called ${args.out}` : ""}`);
	// The page as this machine reaches the server, whatever address the server gives.
	const given = new URL((await api("GET", `/outs/${out.id}/url`)).url, base);
	const url = new URL(given.pathname + given.search, base).href;
	await api("POST", "/templates", {
		id: TITLE_ID,
		name: "notGT bench count",
		kind: "code",
		width: 1100,
		height: 220,
		code: countTitle(options.fps),
	});
	let shown = 0;
	let timer;
	const hides = new Set();
	const hide = () => api("POST", "/titles/hide", { out: out.id, templateId: TITLE_ID });
	let stopped = false;
	return {
		url,
		/** `shown(n)` once show n is on its way, `hidden(n)` as it is hidden. */
		start({ shown: onShown = () => {}, hidden: onHidden = () => {} } = {}) {
			timer = setInterval(async () => {
				const n = ++shown;
				try {
					await api("POST", `/titles/${TITLE_ID}/show`, { out: out.id, data: { bench: { show: n } } });
				} catch (error) {
					console.error(error.message);
					return;
				}
				onShown(n);
				const later = setTimeout(() => {
					hides.delete(later);
					onHidden(n);
					hide().catch((error) => console.error(error.message));
				}, (SHOW_FRAMES * 1000) / options.fps + 500);
				hides.add(later);
			}, options.period);
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			for (const later of hides) clearTimeout(later);
			await hide().catch(() => {});
			await api("DELETE", `/templates/${TITLE_ID}`).catch(() => {});
		},
	};
}

/**
 * --real's code title: bench.html's stamp, count and marker (see there),
 * drawn from the moment notGT shows it — its frames counted from its first
 * animation frame, the marker moved on the compositor.
 */
function countTitle(fps) {
	return {
		html: '<div id="stamp"></div><div id="count"></div><div id="track"><div id="marker"></div></div>',
		css: [
			"html,body{margin:0;background:transparent;overflow:hidden}",
			"#stamp,#count{position:absolute;left:40px;top:128px;display:flex}#count{top:152px}",
			"#stamp i,#count i{width:16px;height:16px;background:#000}#stamp i.on,#count i.on{background:#fff}",
			"#track{position:absolute;left:40px;top:176px;width:1024px;height:16px;background:#000}",
			"#marker{width:16px;height:16px;background:#fff;opacity:0}",
		].join("\n"),
		js: `const FRAMES = ${SHOW_FRAMES};
const frameMs = ${1000 / fps};
const blocks = (id) => {
	const row = document.getElementById(id);
	return Array.from({ length: 32 }, () => row.appendChild(document.createElement("i")));
};
const bits = blocks("stamp");
const countBits = blocks("count");
const write = (row, word) => {
	for (let i = 0; i < 32; i++) row[i].className = Math.floor(word / 2 ** (31 - i)) % 2 ? "on" : "";
};
let drawn = 0;
function draw(entry, frame) {
	const t = Date.now() % 2 ** 24;
	write(bits, t * 256 + (((t & 255) + ((t >> 8) & 255) + ((t >> 16) & 255)) & 255));
	drawn = (drawn + 1) % 256;
	write(countBits, ((entry * 256 + frame) * 256 + drawn) * 256 + ((entry + frame + drawn) & 255));
}
onShow(() => {
	const entry = (Number(vars("bench.show", 0)) % 255) + 1;
	let frame = 0;
	requestAnimationFrame(function tick() {
		if (frame === 0)
			document.getElementById("marker").animate(
				[
					{ opacity: 1, transform: "translateX(0)" },
					{ opacity: 1, transform: "translateX(" + FRAMES * 16 + "px)" },
				],
				{ duration: FRAMES * frameMs, delay: -frameMs / 2, easing: "steps(" + FRAMES + ")" },
			);
		if (frame < FRAMES) {
			draw(entry, frame++);
			requestAnimationFrame(tick);
		}
	});
});`,
	};
}

/** The sender's counts (src/telemetry.mjs) of each out, by its NDI name. */
function pipelines(status) {
	return new Map((status?.outs ?? []).map((out) => [out.ndiName, out.pipeline ?? {}]));
}

/** What each out's counts grew by from `before` to `after`. */
function grown(before, after) {
	return [...after].map(([source, counts]) => ({
		source,
		...Object.fromEntries(
			Object.entries(counts)
				.filter(([what]) => what !== "held")
				.map(([what, n]) => [what, n - (before.get(source)?.[what] ?? 0)]),
		),
	}));
}

/** --every: windows of `every` seconds, one report each, until `seconds`. */
async function everyWindow({ options, sender, server, flag, windowResults, args, say }) {
	const windows = Math.max(1, Math.round(options.seconds / options.every));
	const startedAt = Date.now();
	Atomics.store(flag, 0, 1);
	for (let k = 0; k < windows; k++) {
		if (sender.exitCode !== null) {
			console.log(JSON.stringify({ window: k, error: `the sender ended (code ${sender.exitCode})` }));
			process.exit(1);
		}
		const sampler = sampleGpu(options.every);
		const before = processTree(sender.pid);
		const counted = pipelines(server.lastStatus());
		const started = performance.now();
		await sleep(options.every * 1000);
		const after = processTree(sender.pid);
		const elapsed = (performance.now() - started) / 1000;
		Atomics.store(flag, 1, k + 1);
		const gpu = await sampler;
		const deadline = Date.now() + 10_000;
		while ((windowResults.get(k)?.length ?? 0) < options.outs && Date.now() < deadline)
			await sleep(50);
		const report = {
			window: k + 1,
			minutes: Math.round(((Date.now() - startedAt) / 60_000) * 10) / 10,
			cpu: cpuUse(before, after, elapsed),
			gpuBusy: gpu.busyPercent,
			receivers: windowResults.get(k) ?? [],
			pipeline: grown(counted, pipelines(server.lastStatus())),
		};
		windowResults.delete(k);
		if (args.json) console.log(JSON.stringify(report));
		else
			for (const x of report.receivers)
				say(
					`${report.minutes} min: CPU ${report.cpu.total}%, ${report.cpu.memoryMB} MB, ${x.fps} fps (${x.freshFps} fresh, ${x.lost} lost), interval p50 ${x.intervalMs.p50} / p99 ${x.intervalMs.p99} / max ${x.intervalMs.max} ms, latency p50 ${x.latencyMs.p50} ms, colours ${x.correct ? "right" : "WRONG"} (${x.colourError}, alpha ${x.alphaError})`,
				);
	}
}

// --------------------------------------------------------- the receivers
async function receive({ name, ips, width, height, alpha, patches, connect: joinMs = [], flag }) {
	const { loadNdi } = await import("../src/ndi.mjs");
	const ndi = loadNdi();
	/** --connect: receivers come and go with the shows while measuring. */
	const late = joinMs.length > 0;
	/** The source, once found. */
	let found;
	/** Finds the source again, as receivers do when one comes back elsewhere. */
	const connect = () => {
		let source;
		while (!source && Atomics.load(flag, 0) < 2) {
			source = ndi
				.findSources(1000, ips)
				.find((candidate) => candidate.name.endsWith(`(${name})`));
		}
		if (!source) return undefined;
		found = source;
		parentPort.postMessage({ connected: source.name });
		return ndi.createReceiver(source, `bench receiver for ${name}`);
	};
	let receiver = connect();
	let heardAt = performance.now();

	const newStats = () => ({
		frames: 0,
		fresh: 0,
		badStamps: 0,
		latencies: [],
		intervals: [],
		size: "",
		fourcc: "",
		declaredFps: 0,
		colourError: 0,
		alphaError: 0,
		worst: undefined,
		/** Frames the page drew that never came (its count skipped them). */
		lost: 0,
		/** Between new frames of one motion: all the time, or one show. */
		freshIntervals: [],
		/** #entry: each show that ended, by the count and by the marker. */
		shows: [],
		markers: [],
		/** --connect: each receiver that joined a show. */
		joins: [],
	});
	let stats = newStats();
	let window = 0;
	const sx = width / 1920;
	const sy = height / 1080;
	let lastStamp;
	let lastArrival;
	let checkedAt = 0;
	// #entry's shows, followed across windows, and the last new frame's count.
	let show;
	let marker;
	let lastFresh;
	const endShow = () => {
		if (show?.counted) stats.shows.push(arrived(show));
		show = undefined;
	};
	const endMarker = () => {
		if (marker?.counted) stats.markers.push(arrived(marker));
		marker = undefined;
	};
	/**
	 * Follows the shows in a frame: by its count, and by the marker's place.
	 * Followed while settling too, and counted only when begun measuring: a
	 * show already going is not taken for one that came in late.
	 */
	const follow = (count, place, measuring) => {
		if (count) {
			if (show && show.entry !== count.entry) endShow();
			if (count.entry !== 0) {
				show ??= { entry: count.entry, first: count.frame, frames: new Set(), counted: measuring };
				show.frames.add(count.frame);
			}
		}
		if (place < 0) endMarker();
		else {
			marker ??= { first: place, frames: new Set(), counted: measuring };
			marker.frames.add(place);
		}
	};
	/** A new frame: what the page drew since the last one and never sent is lost. */
	const fresh = (count, now) => {
		// Within one motion: all the time, or one show (a code title counts each show from 0).
		if (lastFresh && count && count.entry === lastFresh.entry) {
			const step = (count.drawn - lastFresh.drawn + 256) % 256;
			if (step > 1) stats.lost += step - 1;
			stats.freshIntervals.push(now - lastFresh.at);
		}
		lastFresh = count ? { ...count, at: now } : undefined;
	};
	/** --connect: the show the receiver now connected joined, and what it got of it. */
	let join;
	const endJoin = () => {
		if (join?.currentMs !== undefined) {
			let missing = 0;
			for (let k = join.firstFrame; k < SHOW_FRAMES; k++) if (!join.frames.has(k)) missing++;
			stats.joins.push({ offset: join.offset, ms: join.currentMs, frame: join.firstFrame, missing });
		} else if (join) stats.joins.push({ offset: join.offset, ms: null, frame: null, missing: null });
		join = undefined;
	};
	while ((receiver || late) && Atomics.load(flag, 0) < 2) {
		const measuring = Atomics.load(flag, 0) === 1;
		if (Atomics.load(flag, 1) !== window) {
			// --every: the window closed; report it, start the next.
			parentPort.postMessage({ window, windowResult: summarise(name, stats) });
			window = Atomics.load(flag, 1);
			stats = newStats();
			lastArrival = undefined;
		}
		if (late && measuring) {
			if (Atomics.load(flag, 2) !== 1) {
				// Between shows: nobody receives.
				if (receiver) {
					receiver.destroy();
					receiver = undefined;
					endJoin();
				}
				Atomics.wait(flag, 2, 0, 50);
				continue;
			}
			if (!receiver) {
				receiver = ndi.createReceiver(found, `bench receiver for ${name}`);
				const n = Atomics.load(flag, 3);
				lastStamp = lastArrival = lastFresh = undefined;
				join = { entry: (n % 255) + 1, offset: joinMs.at((n - 1) % joinMs.length), at: performance.now(), frames: new Set() };
			}
		} else if (!receiver || performance.now() - heardAt > 3000) {
			receiver?.destroy();
			receiver = connect();
			heardAt = performance.now();
			if (!receiver) break;
		}
		receiver.captureVideo(
			late ? 20 : 100,
			(frame) => {
				const now = performance.now();
				heardAt = now;
				/** B, G, R, A at a point of the 1920×1080 layout. */
				const at = (x, y) => {
					const i = Math.round(y * sy) * frame.stride + Math.round(x * sx) * 4;
					return frame.pixels.subarray(i, i + 4);
				};
				/** 32 blocks of 16 px from (40, `top`), white for 1: a number, highest bit first. */
				const word = (top) => {
					let value = 0;
					for (let bit = 0; bit < 32; bit++) {
						const [b, g, r] = at(40 + bit * 16 + 8, top + 8);
						value = value * 2 + ((r + g + b) / 3 > 128 ? 1 : 0);
					}
					return value;
				};
				const count = readCount(word(152));
				follow(count, markerPlace(at), measuring);
				// --connect: the first frame of the show joined, and the rest of it.
				if (join && count?.entry === join.entry) {
					if (join.currentMs === undefined) {
						join.currentMs = now - join.at;
						join.firstFrame = count.frame;
					}
					join.frames.add(count.frame);
				}
				if (!measuring) return;
				stats.frames++;
				stats.size = `${frame.width}×${frame.height}`;
				stats.fourcc = frame.fourcc;
				stats.declaredFps = Math.round(frame.fps * 100) / 100;
				if (lastArrival !== undefined) stats.intervals.push(now - lastArrival);
				lastArrival = now;
				// The time stamp: 32 blocks of 16 px from (40, 128).
				const stamped = word(128);
				const stamp = Math.floor(stamped / 256);
				const sum =
					(stamp & 255) + ((stamp >> 8) & 255) + ((stamp >> 16) & 255);
				if (sum % 256 === stamped % 256) {
					if (stamp !== lastStamp) {
						stats.fresh++;
						const latency =
							((Date.now() % STAMP_WRAP) - stamp + STAMP_WRAP) % STAMP_WRAP;
						if (latency < 10_000) {
							stats.latencies.push(latency);
							if (show && show.latency === undefined) show.latency = latency;
						}
						fresh(count, now);
					}
					lastStamp = stamp;
				} else stats.badStamps++;
				// The patches, about once a second.
				if (patches && now - checkedAt > 1000) {
					checkedAt = now;
					PATCHES.forEach((want, p) => {
						const got = [0, 0, 0, 0];
						let n = 0;
						for (let y = 60; y < 84; y += 2)
							for (let x = 60 + p * 96; x < 84 + p * 96; x += 2) {
								const [b, g, r, a] = at(x, y);
								got[0] += r;
								got[1] += g;
								got[2] += b;
								got[3] += a;
								n++;
							}
						for (let c = 0; c < 4; c++) got[c] = Math.round(got[c] / n);
						// Opaque: the colour over black.
						const expect = alpha
							? want
							: [
									...want
										.slice(0, 3)
										.map((c) => Math.round((c * want[3]) / 255)),
									255,
								];
						const colourError = Math.max(
							...[0, 1, 2].map((c) => Math.abs(got[c] - expect[c])),
						);
						const alphaError = Math.abs(got[3] - expect[3]);
						stats.colourError = Math.max(stats.colourError, colourError);
						stats.alphaError = Math.max(stats.alphaError, alphaError);
						const score = Math.max(
							colourError / TOLERANCE.colour,
							alphaError / TOLERANCE.alpha,
						);
						if (!stats.worst || score > stats.worst.score)
							stats.worst = { score: round(score, 2), patch: p, expect, got };
					});
				}
			},
			{ copy: false },
		);
	}
	receiver?.destroy();
	parentPort.postMessage({ result: summarise(name, stats) });
}

function summarise(name, stats) {
	const seconds = stats.intervals.reduce((a, b) => a + b, 0) / 1000;
	return {
			source: name,
			size: stats.size,
			fourcc: stats.fourcc,
			declaredFps: stats.declaredFps,
			fps: seconds ? round((stats.frames - 1) / seconds, 1) : 0,
			freshFps: seconds ? round(stats.fresh / seconds, 1) : 0,
			intervalMs: percentiles(stats.intervals),
			latencyMs: percentiles(stats.latencies),
			badStamps: stats.badStamps,
			lost: stats.lost,
			freshIntervalMs: percentiles(stats.freshIntervals),
			...(stats.joins.length ? { joins: joined(stats.joins) } : {}),
			...(stats.shows.length || stats.markers.length
				? { entry: { count: together(stats.shows), marker: together(stats.markers) } }
				: {}),
			colourError: stats.colourError,
			alphaError: stats.alphaError,
			// Nothing checked (a real out page): neither right nor wrong.
			correct: stats.worst ? stats.worst.score <= 1 : null,
			worstPatch: stats.worst,
	};
}

/** bench.html's count, when its check sum holds: show, frame of the show, the page's own frame. */
function readCount(word) {
	const entry = Math.floor(word / 2 ** 24) % 256;
	const frame = Math.floor(word / 2 ** 16) % 256;
	const drawn = Math.floor(word / 2 ** 8) % 256;
	if (((entry + frame + drawn) & 255) !== word % 256) return undefined;
	return { entry, frame, drawn };
}

/** #entry: the place of the white marker on the track, 0–63; -1 for none. */
function markerPlace(at) {
	for (let place = 0; place < 64; place++) {
		const [b, g, r] = at(40 + place * 16 + 8, 184);
		if ((r + g + b) / 3 > 128) return place;
	}
	return -1;
}

/** What arrived of one show: from which frame, and which of its frames never did. */
function arrived({ first, frames, latency }) {
	const lost = [];
	for (let k = 0; k < SHOW_FRAMES; k++) if (!frames.has(k)) lost.push(k);
	return {
		first,
		lost,
		missing: lost.length,
		missingAtStart: lost.filter((k) => k < SHOW_START).length,
		...(latency !== undefined ? { latency } : {}),
	};
}

/**
 * --connect: the joins by how far into the show they came — how soon the
 * show's frame of the moment arrived, which frames those were, what was
 * missing after them.
 */
function joined(joins) {
	const byOffset = {};
	for (const j of joins) (byOffset[j.offset] ??= []).push(j);
	return Object.entries(byOffset).map(([offset, list]) => {
		const got = list.filter((j) => j.ms !== null);
		return {
			offset: Number(offset),
			joins: list.length,
			never: list.length - got.length,
			ms: percentiles(got.map((j) => j.ms)),
			frames: got.map((j) => j.frame),
			missing: got.reduce((n, j) => n + j.missing, 0),
		};
	});
}

/** Shows together: how many arrived from frame 0, from which frames the rest, what was missing. */
function together(shows) {
	const firstFrames = {};
	for (const s of shows) firstFrames[s.first] = (firstFrames[s.first] ?? 0) + 1;
	/** Which frames of the shows never arrived, and in how many shows. */
	const lostFrames = {};
	for (const s of shows) for (const k of s.lost) lostFrames[k] = (lostFrames[k] ?? 0) + 1;
	const latencies = shows.map((s) => s.latency).filter((l) => l !== undefined);
	return {
		shows: shows.length,
		fromFrame0: shows.filter((s) => s.first === 0).length,
		firstFrames,
		missingAtStart: shows.reduce((n, s) => n + s.missingAtStart, 0),
		missing: shows.reduce((n, s) => n + s.missing, 0),
		lostFrames,
		...(latencies.length ? { startLatencyMs: percentiles(latencies) } : {}),
	};
}

// ------------------------------------------------------------- the costs
/** CPU seconds, memory and kind of every process under `pid`. */
function processTree(pid) {
	if (process.platform === "linux") return linuxTree(pid);
	if (process.platform === "win32") return windowsTree(pid);
	return psTree(pid);
}

function linuxTree(pid) {
	const all = new Map();
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
			const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			// Chromium rewrites its command line into one string with spaces.
			const args = fs
				.readFileSync(`/proc/${name}/cmdline`, "utf8")
				.replaceAll("\0", " ");
			all.set(Number(name), {
				ppid: Number(fields[1]),
				cpu: (Number(fields[11]) + Number(fields[12])) / 100,
				rss: Number(fields[21]) * 4096,
				kind: kindOf(comm, args),
			});
		} catch {
			// Gone meanwhile.
		}
	}
	return descendants(all, pid);
}

function windowsTree(pid) {
	const out = spawnSync(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize,Name,CommandLine | ConvertTo-Json -Compress",
		],
		{ encoding: "utf8", maxBuffer: 64 * 2 ** 20 },
	);
	const all = new Map();
	for (const p of JSON.parse(out.stdout || "[]")) {
		all.set(p.ProcessId, {
			ppid: p.ParentProcessId,
			cpu: (Number(p.UserModeTime) + Number(p.KernelModeTime)) / 1e7,
			rss: Number(p.WorkingSetSize),
			kind: kindOf(p.Name ?? "", p.CommandLine ?? ""),
		});
	}
	return descendants(all, pid);
}

function psTree(pid) {
	const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,time=,rss=,args="], {
		encoding: "utf8",
	});
	const all = new Map();
	for (const line of out.stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		// [[dd-]hh:]mm:ss.ss
		const parts = m[3].split(/[-:]/).map(Number).reverse();
		const cpu = [1, 60, 3600, 86400].reduce(
			(total, k, i) => total + (parts[i] ?? 0) * k,
			0,
		);
		all.set(Number(m[1]), {
			ppid: Number(m[2]),
			cpu,
			rss: Number(m[4]) * 1024,
			kind: kindOf(path.basename(m[5].split(" ")[0]), m[5]),
		});
	}
	return descendants(all, pid);
}

function kindOf(name, args) {
	if (/^(sway|weston)/.test(name)) return "compositor";
	const type = /--type=([\w-]+)/.exec(args)?.[1];
	if (type === "utility") {
		const sub = /--utility-sub-type=([\w.]+)/.exec(args)?.[1] ?? "";
		return `utility ${sub.split(".").pop()}`;
	}
	if (type) return type;
	if (/electron/i.test(name) || /electron/i.test(args.split(" ")[0] ?? ""))
		return "main";
	return name.replace(/\.exe$/i, "") === "node" ? "launcher" : name;
}

function descendants(all, pid) {
	const tree = new Map();
	const walk = (id) => {
		const entry = all.get(id);
		if (!entry) return;
		tree.set(id, entry);
		for (const [child, value] of all) if (value.ppid === id) walk(child);
	};
	walk(pid);
	return tree;
}

/** % of one core per kind of process, over `seconds`. */
function cpuUse(before, after, seconds) {
	const byKind = {};
	let total = 0;
	let rss = 0;
	for (const [pid, entry] of after) {
		const start = before.get(pid)?.cpu ?? entry.cpu;
		const share = ((entry.cpu - start) / seconds) * 100;
		byKind[entry.kind] = round((byKind[entry.kind] ?? 0) + share, 1);
		total += share;
		rss += entry.rss;
	}
	return {
		total: round(total, 1),
		byKind,
		memoryMB: Math.round(rss / 2 ** 20),
	};
}

/** GPU busy %, sampled over the run, where the driver tells it. */
async function sampleGpu(seconds) {
	if (process.platform === "linux") {
		const files = gpuFiles("gpu_busy_percent");
		if (files.length) {
			const samples = [];
			const end = performance.now() + seconds * 1000;
			while (performance.now() < end) {
				samples.push(
					Math.max(...files.map((f) => Number(fs.readFileSync(f, "utf8")))),
				);
				await sleep(200);
			}
			return { busyPercent: round(average(samples), 1), source: "amdgpu" };
		}
	}
	if (whichSync("nvidia-smi")) {
		const out = await run(
			"nvidia-smi",
			[
				"--query-gpu=utilization.gpu",
				"--format=csv,noheader,nounits",
				"-lms",
				"200",
			],
			seconds,
		);
		const values = out.split("\n").filter(Boolean).map(Number);
		return { busyPercent: round(average(values), 1), source: "nvidia-smi" };
	}
	if (process.platform === "win32") {
		const samples = Math.max(1, Math.floor(seconds) - 1);
		const out = await run(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${samples}).CounterSamples | Group-Object TimeStamp | ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum }`,
			],
			seconds + 5,
		);
		const values = out.split(/\s+/).filter(Boolean).map(Number);
		return {
			busyPercent: round(average(values), 1),
			source: "Windows GPU Engine 3D counters",
		};
	}
	return { busyPercent: null, source: "not measured on this machine" };
}

function gpuFiles(name) {
	try {
		return fs
			.readdirSync("/sys/class/drm")
			.filter((card) => /^card\d+$/.test(card))
			.map((card) => `/sys/class/drm/${card}/device/${name}`)
			.filter((file) => fs.existsSync(file));
	} catch {
		return [];
	}
}

function gpuMemory() {
	const vram = gpuFiles("mem_info_vram_used");
	if (!vram.length) return undefined;
	const sum = (files) =>
		files.reduce((total, f) => total + Number(fs.readFileSync(f, "utf8")), 0);
	return { vram: sum(vram), gtt: sum(gpuFiles("mem_info_gtt_used")) };
}

function machine() {
	const cpus = os.cpus();
	return {
		platform: `${process.platform}-${process.arch}`,
		cpu: `${cpus[0]?.model ?? "?"} × ${cpus.length}`,
		memoryGB: Math.round(os.totalmem() / 2 ** 30),
	};
}

// ---------------------------------------------------------------- report
function printReport(r) {
	console.log("");
	console.log(
		`machine   ${r.machine.platform}, ${r.machine.cpu}, ${r.machine.memoryGB} GB`,
	);
	console.log(`render    ${r.render || "?"}${r.adapter ? ` — ${r.adapter}` : ""}`);
	for (const line of r.senderSays) console.log(`          ${line}`);
	const kinds = Object.entries(r.cpu.byKind)
		.filter(([, v]) => v >= 0.1)
		.map(([k, v]) => `${k} ${v}%`)
		.join(", ");
	console.log(`CPU       ${r.cpu.total}% of a core (${kinds})`);
	console.log(`memory    ${r.cpu.memoryMB} MB resident`);
	const g = r.gpu;
	const memory =
		g.vramMB === undefined ? "" : `, +${g.vramMB} MB VRAM, +${g.gttMB} MB GTT`;
	console.log(
		`GPU       ${g.busyPercent === null ? "—" : `${g.busyPercent}% busy`} (${g.source})${memory}`,
	);
	for (const x of r.receivers) {
		const worst = x.worstPatch
			? ` (worst: patch ${x.worstPatch.patch}, ${x.worstPatch.got.join(",")} for ${x.worstPatch.expect.join(",")})`
			: "";
		console.log(
			`${x.source}: ${x.size} ${x.fourcc}, ${x.fps} fps (declared ${x.declaredFps}), ${x.freshFps} fresh fps, interval p50 ${x.intervalMs.p50} / p95 ${x.intervalMs.p95} / p99 ${x.intervalMs.p99} / max ${x.intervalMs.max} ms, latency p50 ${x.latencyMs.p50} / p95 ${x.latencyMs.p95} ms, ${x.correct === null ? "colours not checked" : `colours ${x.correct ? "right" : "WRONG"} (off by ${x.colourError} at most, alpha by ${x.alphaError})${x.correct ? "" : worst}`}`,
		);
		const f = x.freshIntervalMs;
		console.log(
			`          ${x.lost} frame(s) the page drew never arrived; between new frames p50 ${f.p50} / p99 ${f.p99} / max ${f.max} ms`,
		);
		for (const j of x.joins ?? [])
			console.log(
				`          joined ${j.offset} ms into a show (${j.joins}×): its frame of the moment came after p50 ${j.ms.p50} / max ${j.ms.max} ms, frames ${j.frames.join(" ")}${j.never ? `, ${j.never} never` : ""}; ${j.missing} missing after them`,
			);
		if (x.entry) {
			for (const [how, e] of [
				["by script (the count)", x.entry.count],
				["on the compositor (the marker)", x.entry.marker],
			])
				console.log(
					`          shows ${how}: ${e.fromFrame0} of ${e.shows} arrived from frame 0 (first frames ${JSON.stringify(e.firstFrames)}), ${e.missingAtStart} frame(s) missing from their first ${SHOW_START}, ${e.missing} in all${e.missing ? ` (which, in how many shows: ${JSON.stringify(e.lostFrames)})` : ""}${e.startLatencyMs ? `, first frame ${e.startLatencyMs.p50} ms after it was drawn (p50)` : ""}`,
				);
		}
	}
	for (const p of r.pipeline ?? [])
		console.log(
			`sender    ${p.source}: ${p.painted} painted, ${p.replaced} replaced waiting, ${p.converted} converted, ${p.fresh} sent new and ${p.repeats} again, ${p.dropped} dropped by the clock${p.skipped ? `, ${p.skipped} skipped` : ""}`,
		);
}

// ----------------------------------------------------------------- small
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args[key] = next;
			i++;
		} else args[key] = true;
	}
	return args;
}

function average(values) {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(value, digits) {
	const k = 10 ** digits;
	return Math.round(value * k) / k;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function whichSync(command) {
	for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
		for (const ext of process.platform === "win32" ? [".exe", ""] : [""]) {
			if (dir && fs.existsSync(path.join(dir, command + ext))) return true;
		}
	}
	return false;
}

/** The output of `command`, stopped after `seconds`. */
function run(command, args, seconds) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (out += chunk));
		const timer = setTimeout(() => child.kill(), seconds * 1000);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
		child.on("error", () => resolve(out));
	});
}
