#!/usr/bin/env node
/**
 * Measures the NDI sender end to end on this machine, through real NDI
 * receivers: what it costs (CPU per process, the compositor included; GPU;
 * memory), what comes out (frame rate, fresh frames, latency) and whether it
 * is right (known colours and alpha, checked in what the receiver gets).
 *
 *   node scripts/bench.mjs [--render auto|gpu|cpu] [--page still|lower|full]
 *        [--outs 1] [--size 1920x1080] [--fps 30] [--seconds 10] [--opaque]
 *        [--ips 127.0.0.1] [--json] [--log] [--every 60]
 *
 * It plays the notGT server itself (the outs, the page: test/fixtures/
 * bench.html), starts bin/notgt-ndi.mjs as anyone would, and receives every
 * source in a worker thread of its own. The receivers' own work is not
 * counted. Needs the NDI library, as the sender does.
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
		seconds: Number(args.seconds) || 10,
		alpha: !args.opaque,
		ips: typeof args.ips === "string" ? args.ips : "127.0.0.1",
		every: Number(args.every) || 0,
	};
	const say = args.json ? () => {} : (line) => console.log(line);

	const gpuBefore = gpuMemory();
	const server = await serve(options);
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
	for (const stream of [sender.stdout, sender.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			for (const line of chunk.split("\n"))
				if (line.startsWith("[notgt-ndi]")) {
					senderLog.push(line.slice(12));
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
	// 1 measuring, 2 done; flag[1]: the window being measured (--every).
	const flag = new Int32Array(new SharedArrayBuffer(8));
	const windowResults = new Map();
	const workers = Array.from({ length: options.outs }, (_, i) => {
		const worker = new Worker(fileURLToPath(import.meta.url), {
			workerData: {
				name: sourceName(i),
				ips: options.ips,
				width,
				height,
				alpha: options.alpha,
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
			`The sender did not start sending in time. It said:\n${senderLog.join("\n")}`,
		);
		process.exit(1);
	}
	// Let it settle: first frames, receivers connected, painting at the full rate.
	await sleep(5000);
	if (options.every) {
		await everyWindow({ options, sender, flag, windowResults, args, say });
		Atomics.store(flag, 0, 2);
		await Promise.all(workers);
		stopSender();
		server.close();
		process.exit(0);
	}

	const sampler = sampleGpu(options.seconds);
	const before = processTree(sender.pid);
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
	stopSender();
	server.close();

	const report = {
		machine: machine(),
		options,
		render: [...new Set((status?.outs ?? []).map((out) => out.render))].join(
			"+",
		),
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
	return `notGT bench ${i + 1}`;
}

/** The notGT server, as far as the sender needs one. */
function serve({ outs, width, height, fps, alpha, page }) {
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
						url: `/bench.html#${page}`,
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

/** --every: windows of `every` seconds, one report each, until `seconds`. */
async function everyWindow({ options, sender, flag, windowResults, args, say }) {
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
		};
		windowResults.delete(k);
		if (args.json) console.log(JSON.stringify(report));
		else
			for (const x of report.receivers)
				say(
					`${report.minutes} min: CPU ${report.cpu.total}%, ${report.cpu.memoryMB} MB, ${x.fps} fps (${x.freshFps} fresh), interval p50 ${x.intervalMs.p50} / p95 ${x.intervalMs.p95} / max ${x.intervalMs.max} ms, latency p50 ${x.latencyMs.p50} ms, colours ${x.correct ? "right" : "WRONG"} (${x.colourError}, alpha ${x.alphaError})`,
				);
	}
}

// --------------------------------------------------------- the receivers
async function receive({ name, ips, width, height, alpha, flag }) {
	const { loadNdi } = await import("../src/ndi.mjs");
	const ndi = loadNdi();
	/** Finds the source again, as receivers do when one comes back elsewhere. */
	const connect = () => {
		let source;
		while (!source && Atomics.load(flag, 0) < 2) {
			source = ndi
				.findSources(1000, ips)
				.find((candidate) => candidate.name.endsWith(`(${name})`));
		}
		if (!source) return undefined;
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
	});
	let stats = newStats();
	let window = 0;
	const sx = width / 1920;
	const sy = height / 1080;
	let lastStamp;
	let lastArrival;
	let checkedAt = 0;
	while (receiver && Atomics.load(flag, 0) < 2) {
		const measuring = Atomics.load(flag, 0) === 1;
		if (Atomics.load(flag, 1) !== window) {
			// --every: the window closed; report it, start the next.
			parentPort.postMessage({ window, windowResult: summarise(name, stats) });
			window = Atomics.load(flag, 1);
			stats = newStats();
			lastArrival = undefined;
		}
		if (performance.now() - heardAt > 3000) {
			receiver.destroy();
			receiver = connect();
			heardAt = performance.now();
			if (!receiver) break;
		}
		receiver.captureVideo(
			100,
			(frame) => {
				heardAt = performance.now();
				if (!measuring) return;
				const now = performance.now();
				stats.frames++;
				stats.size = `${frame.width}×${frame.height}`;
				stats.fourcc = frame.fourcc;
				stats.declaredFps = Math.round(frame.fps * 100) / 100;
				if (lastArrival !== undefined) stats.intervals.push(now - lastArrival);
				lastArrival = now;
				/** B, G, R, A at a point of the 1920×1080 layout. */
				const at = (x, y) => {
					const i = Math.round(y * sy) * frame.stride + Math.round(x * sx) * 4;
					return frame.pixels.subarray(i, i + 4);
				};
				// The time stamp: 32 blocks of 16 px from (40, 128).
				let word = 0;
				for (let bit = 0; bit < 32; bit++) {
					const [b, g, r] = at(40 + bit * 16 + 8, 136);
					word = word * 2 + ((r + g + b) / 3 > 128 ? 1 : 0);
				}
				const stamp = Math.floor(word / 256);
				const sum =
					(stamp & 255) + ((stamp >> 8) & 255) + ((stamp >> 16) & 255);
				if (sum % 256 === word % 256) {
					if (stamp !== lastStamp) {
						stats.fresh++;
						const latency =
							((Date.now() % STAMP_WRAP) - stamp + STAMP_WRAP) % STAMP_WRAP;
						if (latency < 10_000) stats.latencies.push(latency);
					}
					lastStamp = stamp;
				} else stats.badStamps++;
				// The patches, about once a second.
				if (now - checkedAt > 1000) {
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
			colourError: stats.colourError,
			alphaError: stats.alphaError,
			correct: stats.worst ? stats.worst.score <= 1 : false,
			worstPatch: stats.worst,
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
	console.log(`render    ${r.render || "?"}`);
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
			`${x.source}: ${x.size} ${x.fourcc}, ${x.fps} fps (declared ${x.declaredFps}), ${x.freshFps} fresh fps, interval p50 ${x.intervalMs.p50} / p95 ${x.intervalMs.p95} / max ${x.intervalMs.max} ms, latency p50 ${x.latencyMs.p50} / p95 ${x.latencyMs.p95} ms, colours ${x.correct ? "right" : "WRONG"} (off by ${x.colourError} at most, alpha by ${x.alphaError})${x.correct ? "" : worst}`,
		);
	}
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

function percentiles(values) {
	if (!values.length) return { p50: null, p95: null, max: null };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q) =>
		round(
			sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))],
			1,
		);
	return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1), 1) };
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
