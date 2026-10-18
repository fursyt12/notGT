#!/usr/bin/env node
/**
 * Everything needed to judge the NDI sender's converters on this machine,
 * collected into one zip to send back:
 *
 *   node scripts/diagnose.mjs [--quick | --long] [--seconds 20] [--out <dir>]
 *
 * 1. the machine: system, CPU, memory, GPUs and their drivers, versions;
 * 2. Vulkan as the native converter sees it — every GPU, and whether and why
 *    not it can take Chromium's frames — and a self-test of the converter on
 *    the GPU it would use, checked against the CPU byte for byte;
 * 3. benchmarks through real NDI receivers (scripts/bench.mjs), one at a
 *    time: the native converter and WebGL2, full screen and a lower third,
 *    1080p60 — CPU per process, memory, frame rate and intervals, latency,
 *    colours and alpha, and how long each conversion takes. --quick does
 *    full screen only; --long adds ten minutes of the native one.
 *
 * Plain Node is enough (the Windows package's node\node.exe): the sender is
 * started by the benchmark itself, as the launcher would. Needs the NDI
 * runtime (NDI Tools), as the sender does.
 *
 * Nothing personal goes in: the computer's name, the user's name, the home
 * folder and network addresses are replaced in everything written.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const args = parseArgs(process.argv.slice(2));
const seconds = Number(args.seconds) || (args.quick ? 15 : 20);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const name = `notgt-ndi-diagnostics-${stamp}`;
const outRoot = typeof args.out === "string" ? args.out : defaultOut();
const dir = path.join(outRoot, name);
fs.mkdirSync(path.join(dir, "runs"), { recursive: true });

const journal = [];
function say(line) {
	console.log(line);
	journal.push(line);
}

// ------------------------------------------------------------- privacy
const replacements = [
	[os.homedir(), "<home>"],
	[os.userInfo().username, "<user>"],
	[os.hostname(), "<computer>"],
]
	.filter(([text]) => text && text.length >= 3)
	.flatMap(([text, mark]) => [
		[text, mark],
		// As JSON writes it.
		[JSON.stringify(text).slice(1, -1), mark],
	]);

function scrub(text) {
	let out = String(text);
	for (const [secret, mark] of replacements)
		out = out.replace(new RegExp(escapeRegExp(secret), "gi"), mark);
	// Network addresses, except this machine's own loopback.
	return out.replace(/\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function write(file, data) {
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	fs.writeFileSync(path.join(dir, file), scrub(text));
}

// ------------------------------------------------------------- the run
say(`notGT NDI diagnostics → ${scrub(dir)}.zip`);
say("Nothing personal is collected: names, the home folder and addresses are replaced.\n");

const system = collectSystem();
const vulkan = await collectVulkan();
write("system.json", system);
write("vulkan.json", vulkan);
say(`${system.os.name ?? system.os.platform} · ${system.cpu.model} × ${system.cpu.threads} · ${system.memoryGB} GB`);
for (const gpu of system.gpus) say(`GPU: ${gpu.name}${gpu.driver ? `, driver ${gpu.driver}` : ""}`);
say(`notGT NDI sender ${system.versions.sender}, Electron ${system.versions.electron}, NDI ${system.versions.ndi ?? "not found"}`);
for (const line of vulkan.lines) say(line);
say("");

const plan = args.quick
	? [
			["native", "full"],
			["webgl", "full"],
		]
	: [
			["native", "full"],
			["webgl", "full"],
			["native", "lower"],
			["webgl", "lower"],
		];
const runs = [];
for (const [converter, page] of plan) {
	say(`Run: ${converter} converter, ${page === "full" ? "full screen" : "lower third"}, 1080p60, ${seconds} s …`);
	const result = await bench({ converter, page, seconds });
	runs.push(result);
	say(`  ${oneLine(result)}`);
}
if (args.long) {
	say("Run: native converter, full screen, 1080p60, 10 minutes, reported every minute …");
	const result = await bench({ converter: "native", page: "full", seconds: 600, every: 60 });
	runs.push(result);
	say(`  ${oneLine(result)}`);
}

const summary = summarise(system, vulkan, runs);
write("summary.json", summary.json);
write("summary.txt", summary.text);
say(`\n${summary.text}`);
write("diagnose.log", journal.join("\n"));

const zip = `${dir}.zip`;
writeZip(dir, zip);
fs.rmSync(dir, { recursive: true, force: true });
say(`\nDone. Send this file: ${zip}`);

// ------------------------------------------------------------- the machine
function collectSystem() {
	const cpus = os.cpus();
	const readJson = (file) => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return {};
		}
	};
	const system = {
		collected: new Date().toISOString(),
		os: {
			platform: process.platform,
			arch: process.arch,
			release: os.release(),
			version: os.version?.() ?? "",
		},
		cpu: { model: cpus[0]?.model?.trim() ?? "", threads: cpus.length },
		memoryGB: Math.round(os.totalmem() / 2 ** 30),
		versions: {
			sender: readJson(path.join(root, "package.json")).version,
			electron: readJson(path.join(root, "node_modules", "electron", "package.json")).version,
			node: process.versions.node,
		},
		gpus: [],
		settings: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => /^NOTGT_NDI_|^NDI_/.test(key)),
		),
	};
	if (process.platform === "win32") {
		const osInfo = powershell(
			"Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber | ConvertTo-Json -Compress",
		);
		if (osInfo) {
			system.os.name = osInfo.Caption;
			system.os.build = osInfo.BuildNumber;
		}
		const video = powershell(
			"Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterCompatibility,PNPDeviceID | ConvertTo-Json -Compress",
		);
		for (const v of [video ?? []].flat())
			system.gpus.push({
				name: v.Name,
				vendor: v.AdapterCompatibility,
				driver: v.DriverVersion,
				driverDate: v.DriverDate,
				// PCI\VEN_10DE&DEV_2684&…: the ids only.
				pci: /VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(v.PNPDeviceID ?? "")?.slice(1, 3).join(":"),
			});
	} else if (process.platform === "linux") {
		const pretty = /^PRETTY_NAME="?([^"\n]+)/m.exec(read("/etc/os-release"));
		if (pretty) system.os.name = pretty[1];
		for (const card of safeList("/sys/class/drm").filter((n) => /^renderD\d+$/.test(n))) {
			const device = `/sys/class/drm/${card}/device`;
			system.gpus.push({
				name: card,
				pci: `${read(`${device}/vendor`).replace("0x", "")}:${read(`${device}/device`).replace("0x", "")}`,
				driver: path.basename(safeLink(`${device}/driver`)),
			});
		}
	}
	const smi = spawnSync(
		"nvidia-smi",
		["--query-gpu=name,driver_version,memory.total,pstate,pcie.link.gen.current,pcie.link.width.current", "--format=csv,noheader"],
		{ encoding: "utf8" },
	);
	if (smi.status === 0) system.nvidia = smi.stdout.trim().split("\n");
	return system;
}

function powershell(command) {
	const out = spawnSync("powershell", ["-NoProfile", "-Command", command], {
		encoding: "utf8",
		maxBuffer: 16 * 2 ** 20,
	});
	try {
		return JSON.parse(out.stdout);
	} catch {
		return undefined;
	}
}

function read(file) {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

function safeList(dirPath) {
	try {
		return fs.readdirSync(dirPath);
	} catch {
		return [];
	}
}

function safeLink(file) {
	try {
		return fs.readlinkSync(file);
	} catch {
		return "";
	}
}

// ------------------------------------------------------------- Vulkan
async function collectVulkan() {
	const out = { lines: [] };
	let ndi;
	try {
		ndi = (await import("../src/ndi.mjs")).loadNdi();
		system.versions.ndi = ndi.version;
	} catch (error) {
		out.ndi = error.message;
		out.lines.push(`NDI: ${error.message}`);
	}
	const { loadNative, describeProbe } = await import("../src/native.mjs");
	const native = loadNative();
	if (!native.module) {
		out.addon = native.why;
		out.lines.push(`native converter: ${native.why}`);
		return out;
	}
	out.addon = "loaded";
	const probe = native.module.probe(undefined);
	out.probe = probe;
	out.lines.push(...describeProbe(probe));
	if (!ndi || !probe.devices.some((d) => d.usable)) return out;
	// The converter on the GPU it would pick, checked byte for byte.
	try {
		const test = new native.module.NativeOut({
			ndiFile: ndi.file,
			ndiName: `notGT diagnostics ${process.pid}`,
			fps: 60,
			alpha: true,
		});
		try {
			out.selfTest = { backend: test.backend, result: test.selfTest() };
			out.lines.push(`self-test on ${test.backend}: ${out.selfTest.result}`);
		} finally {
			test.close();
		}
	} catch (error) {
		out.selfTest = { error: error.message };
		out.lines.push(`self-test: FAILED — ${error.message}`);
	}
	return out;
}

// ------------------------------------------------------------- the runs
function bench({ converter, page, seconds, every }) {
	const label = `${converter}-${page}${every ? "-long" : ""}`;
	const benchArgs = [
		path.join(root, "scripts", "bench.mjs"),
		"--render",
		String(args.render ?? "auto"),
		"--page",
		page,
		"--fps",
		"60",
		"--seconds",
		String(seconds),
		"--json",
		"--log",
		...(every ? ["--every", String(every)] : []),
	];
	return new Promise((resolve) => {
		const child = spawn(process.execPath, benchArgs, {
			cwd: root,
			env: { ...process.env, NOTGT_NDI_CONVERTER: converter, NOTGT_NDI_DEBUG: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill(), (seconds + 180) * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			write(`runs/${label}.json`, stdout);
			write(`runs/${label}.log`, stderr);
			const reports = stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line));
			resolve({ label, converter, page, code, reports, log: stderr });
		});
	});
}

/** What the sender says it converted with, and how long a conversion took. */
function converterSays(log) {
	const lines = log.split("\n").map((l) => l.replace(/^\[notgt-ndi\]\s*/, ""));
	const used =
		lines.find((l) => /converting with Vulkan/.test(l)) ??
		lines.find((l) => /WebGL2 on/.test(l)) ??
		lines.find((l) => /drawing on the CPU|converting with .* instead/.test(l));
	const fellBack = lines.filter((l) => /cannot be used|instead/.test(l));
	const native = [...log.matchAll(/(\d+) frames converted natively \((\d+) imported\), ([\d.]+) ms on the GPU and ([\d.]+) ms in all/g)];
	const webgl = [...log.matchAll(/(\d+) frames converted on the GPU, ([\d.]+) ms on the GPU and ([\d.]+) ms reading back/g)];
	const median = (values) => {
		const sorted = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
		return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
	};
	return {
		used: used ?? "",
		fellBack,
		gpuInfo: lines.filter((l) => /^(GPU:|drawing on|Chromium draws on|native converter:)/.test(l)),
		conversion: native.length
			? {
					kind: "native",
					frames: native.reduce((n, m) => n + Number(m[1]), 0),
					imports: native.reduce((n, m) => n + Number(m[2]), 0),
					gpuMs: median(native.map((m) => Number(m[3]))),
					totalMs: median(native.map((m) => Number(m[4]))),
				}
			: webgl.length
				? {
						kind: "webgl",
						frames: webgl.reduce((n, m) => n + Number(m[1]), 0),
						gpuMs: median(webgl.map((m) => Number(m[2]))),
						readBackMs: median(webgl.map((m) => Number(m[3]))),
					}
				: null,
	};
}

function oneLine(run) {
	const r = run.reports.at(-1);
	if (!r) return `no result (exit ${run.code}) — see runs/${run.label}.log`;
	if (r.error) return `stopped: ${r.error}`;
	const rx = r.receivers?.[0];
	if (!rx) return "no receiver result";
	return `CPU ${r.cpu?.total}%, ${r.cpu?.memoryMB} MB, ${rx.fps} fps, interval p95 ${rx.intervalMs?.p95} ms, latency p50 ${rx.latencyMs?.p50} ms, colours ${rx.correct ? "right" : "WRONG"}`;
}

function summarise(system, vulkan, runs) {
	const rows = runs.map((run) => {
		const last = run.reports.at(-1) ?? {};
		const rx = last.receivers?.[0] ?? {};
		const says = converterSays(run.log);
		return {
			run: run.label,
			exit: run.code,
			converterUsed: says.used,
			fellBack: says.fellBack,
			gpuInfo: says.gpuInfo,
			cpuTotal: last.cpu?.total,
			cpuByProcess: last.cpu?.byKind,
			memoryMB: last.cpu?.memoryMB,
			gpuBusy: last.gpu?.busyPercent ?? last.gpuBusy,
			gpuSource: last.gpu?.source,
			fps: rx.fps,
			declaredFps: rx.declaredFps,
			intervalMs: rx.intervalMs,
			latencyMs: rx.latencyMs,
			coloursRight: rx.correct,
			colourError: rx.colourError,
			alphaError: rx.alphaError,
			tornOrUnreadableFrames: rx.badStamps,
			conversion: says.conversion,
			windows: run.reports.length > 1 ? run.reports : undefined,
		};
	});
	const lines = [
		"notGT NDI diagnostics",
		`machine   ${system.os.name ?? system.os.platform} (${system.os.release}), ${system.cpu.model} × ${system.cpu.threads}, ${system.memoryGB} GB`,
		...system.gpus.map((g) => `GPU       ${g.name}${g.driver ? `, driver ${g.driver}` : ""}${g.pci ? `, PCI ${g.pci}` : ""}`),
		...(system.nvidia ?? []).map((n) => `nvidia    ${n}`),
		`versions  sender ${system.versions.sender}, Electron ${system.versions.electron}, NDI ${system.versions.ndi ?? "—"}`,
		...vulkan.lines.map((l) => `vulkan    ${l}`),
		"",
		"run            converter used                    CPU%    MB   fps  int p95  lat p50/p95  colours  torn  conversion",
	];
	for (const row of rows) {
		const conv = row.conversion
			? row.conversion.kind === "native"
				? `${row.conversion.totalMs} ms (${row.conversion.imports} imports)`
				: `${row.conversion.gpuMs} + ${row.conversion.readBackMs} ms`
			: "—";
		const used = /Vulkan/.test(row.converterUsed)
			? "native (Vulkan)"
			: /WebGL2/.test(row.converterUsed)
				? "WebGL2"
				: /CPU/.test(row.converterUsed)
					? "CPU"
					: row.converterUsed.slice(0, 30) || "?";
		lines.push(
			[
				row.run.padEnd(14),
				used.padEnd(32),
				String(row.cpuTotal ?? "—").padStart(5),
				String(row.memoryMB ?? "—").padStart(5),
				String(row.fps ?? "—").padStart(5),
				String(row.intervalMs?.p95 ?? "—").padStart(7),
				`${row.latencyMs?.p50 ?? "—"}/${row.latencyMs?.p95 ?? "—"}`.padStart(11),
				(row.coloursRight ? "right" : "WRONG").padStart(8),
				String(row.tornOrUnreadableFrames ?? "—").padStart(5),
				` ${conv}`,
			].join(" "),
		);
		for (const f of row.fellBack) lines.push(`               fallback: ${f}`);
	}
	return { json: { system, vulkan, runs: rows }, text: lines.join("\n") };
}

// ------------------------------------------------------------- the zip
/** A plain zip of `folder`, deflated: what Windows' Explorer opens. */
function writeZip(folder, file) {
	const entries = [];
	const walk = (dirPath, prefix) => {
		for (const entryName of fs.readdirSync(dirPath)) {
			const full = path.join(dirPath, entryName);
			const rel = `${prefix}/${entryName}`;
			if (fs.statSync(full).isDirectory()) walk(full, rel);
			else entries.push([rel, fs.readFileSync(full)]);
		}
	};
	walk(folder, path.basename(folder));
	const parts = [];
	const central = [];
	let offset = 0;
	for (const [rel, data] of entries) {
		const nameBytes = Buffer.from(rel, "utf8");
		const packed = zlib.deflateRawSync(data);
		const crc = zlib.crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt32LE(0x00210000, 10); // 00:00, 1980-01-01
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, nameBytes, packed);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(0x00210000, 12);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);
		offset += local.length + nameBytes.length + packed.length;
	}
	const centralSize = central.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	fs.writeFileSync(file, Buffer.concat([...parts, ...central, end]));
}

// ------------------------------------------------------------- helpers
function defaultOut() {
	const desktop = path.join(os.homedir(), "Desktop");
	return fs.existsSync(desktop) ? desktop : os.homedir();
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			out[key] = next;
			i++;
		} else out[key] = true;
	}
	return out;
}
