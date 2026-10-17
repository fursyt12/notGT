#!/usr/bin/env node
/**
 * notGT launcher
 * --------------
 * A small, dependency-free local control panel for the notGT (NodeCG) server.
 *
 * It does three things:
 *   1. Serves a tiny local-only HTTP UI (bound to 127.0.0.1, never a network iface).
 *   2. Writes cfg/nodecg.json (host/port) and spawns `node index.js` with cwd = appDir.
 *      NodeCG only reads host/port from that config file; there are no CLI flags.
 *   3. Reports state/logs to the UI and manages the child process tree.
 *
 * No npm dependencies: Node builtins only. Runs on Windows, macOS and Linux.
 *
 * Usage:
 *   node launcher/index.mjs [--app <dir>] [--control-port <n>] [--no-open]
 *                           [--host <ip>] [--port <n>]
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = "2.0.0";
const LOG_BUFFER_MAX = 400; // keep the last ~400 log lines
// The first launch on Windows can be slow: Defender scans the ~44k extracted
// files, SQLite initialises and chokidar walks the tree. 30 s proved too tight,
// so the default is generous and `--ready-timeout` can override it.
let READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 400;
const READY_NOTICE_MS = 10_000; // how often to say "still waiting" in the log
// When the server answers on 127.0.0.1 but not on the chosen address, it is
// running and the *network* is the problem - nearly always the Windows
// firewall dropping inbound packets. Sitting out the whole READY_TIMEOUT_MS
// for that is pure wasted time, so report it as soon as we are sure.
const UNREACHABLE_NOTICE_MS = 8_000;
const FIREWALL_CACHE_MS = 10_000; // how long a `netsh` answer is reused
const KILL_GRACE_MS = 5_000; // SIGTERM -> wait -> SIGKILL grace period
const DEFAULT_PORT = 9090;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = {
		app: null,
		controlPort: 0,
		open: true,
		host: null,
		port: null,
		readyTimeout: null,
		lang: null,
		settings: null,
		background: false,
		runtime: null,
		ndi: true,
		installFfmpeg: null, // status file: this process is the elevated installer
		ffmpegDir: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--app") out.app = argv[++i];
		else if (arg === "--control-port") out.controlPort = Number(argv[++i]);
		else if (arg === "--no-open") out.open = false;
		else if (arg === "--host") out.host = argv[++i];
		else if (arg === "--port") out.port = Number(argv[++i]);
		else if (arg === "--ready-timeout") out.readyTimeout = Number(argv[++i]);
		else if (arg === "--lang") out.lang = argv[++i];
		else if (arg === "--settings") out.settings = argv[++i];
		else if (arg === "--background") out.background = true;
		else if (arg === "--runtime") out.runtime = argv[++i];
		else if (arg === "--no-ndi") out.ndi = false;
		else if (arg === "--install-ffmpeg") out.installFfmpeg = argv[++i];
		else if (arg === "--ffmpeg-dir") out.ffmpegDir = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
/**
 * Where a running launcher says how to reach it (`{ pid, port }`). The window
 * reads it on start: a server that was left running when the window was
 * closed is found again through the launcher that still looks after it.
 */
const RUNTIME_PATH = args.runtime
	? path.resolve(args.runtime)
	: path.join(__dirname, "launcher-runtime.json");
/** Where the last interface, port and language are remembered. */
const PERSIST_PATH = args.settings
	? path.resolve(args.settings)
	: path.join(__dirname, "launcher-config.json");

if (Number.isFinite(args.readyTimeout) && args.readyTimeout > 0) {
	READY_TIMEOUT_MS = args.readyTimeout * 1000;
}

// Default app dir is the repo root (one level above launcher/).
const appDir = path.resolve(args.app ?? path.join(__dirname, ".."));

/**
 * The NDI sender (`ndi/` next to `launcher/`, in the repository and in the
 * packages). Started with the server and stopped with it, so the outs with
 * NDI switched on in the dashboard go out with nothing else to run. The
 * server keeps the senders' key in NDI_KEY_FILE for it.
 */
const ndiDir = path.resolve(__dirname, "..", "ndi");
const NDI_ENTRY = path.join(ndiDir, "bin", "notgt-ndi.mjs");
const NDI_KEY_FILE = path.join(appDir, "db", "notGT-ndi.key");
/** Waits between restarts of a sender that keeps ending: 5 s, 10 s, 20 s … a minute. */
const NDI_RESTART_MS = 5000;
const NDI_RESTART_MAX_MS = 60_000;
let ndiRestartMs = NDI_RESTART_MS;
const ndiWanted =
	args.ndi &&
	!["off", "false", "no", "0"].includes(
		String(process.env.NOTGT_NDI ?? "").toLowerCase(),
	);

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * Where the launcher keeps an ffmpeg of its own (`ffmpeg/` next to
 * `launcher/`). The server is told about it through NOTGT_FFMPEG_DIR and looks
 * there on every conversion, so an ffmpeg installed while it runs is used at
 * once, without a restart. Writing there can take administrator rights (a
 * package unpacked somewhere protected): see installFfmpegElevated.
 */
const FFMPEG_DIR = path.resolve(
	args.ffmpegDir ||
		process.env.NOTGT_FFMPEG_DIR ||
		path.join(__dirname, "..", "ffmpeg"),
);
const FFMPEG_META = path.join(FFMPEG_DIR, "notgt-ffmpeg.json");
/**
 * BtbN's Windows builds: LGPL (no x264 and friends — the converter only needs
 * VP9 and WebP), shared (the DLLs make the archive half as large). The newest
 * release branch is picked from the release; the master build is the fallback
 * when GitHub's API does not answer.
 */
const FFMPEG_RELEASE_API =
	"https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FFMPEG_DOWNLOAD_BASE =
	"https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
const FFMPEG_FALLBACK_ASSET = "ffmpeg-master-latest-win64-lgpl-shared.zip";
/** A zip to install from instead (tests); offers the install on any system. */
const FFMPEG_URL_OVERRIDE = process.env.NOTGT_FFMPEG_URL ?? "";
/** How long a look for an ffmpeg on PATH is trusted. */
const FFMPEG_SYSTEM_CACHE_MS = 60_000;
/**
 * Tests only, for the way through an elevated process where there is no UAC:
 * `direct` runs that process without elevation, `decline` acts as if the
 * prompt was refused.
 */
const ELEVATE_OVERRIDE = process.env.NOTGT_ELEVATE ?? "";

/**
 * Whether this process has administrator rights. `fltmc` lists the filter
 * drivers and is refused without them; it needs no service running, which
 * `net session` does. Asked once: a process does not change its rights.
 */
const IS_ELEVATED = (() => {
	if (ELEVATE_OVERRIDE) return false;
	if (process.platform !== "win32") return true;
	try {
		return (
			spawnSync("fltmc", [], {
				stdio: "ignore",
				windowsHide: true,
				timeout: 10_000,
			}).status === 0
		);
	} catch {
		return false;
	}
})();

const ffmpegState = {
	installing: false,
	progress: 0, // 0..1 while installing
	stage: null, // tr() pair: what the install is doing, or how it ended
	failed: false,
	systemCheckedAt: 0,
	system: false,
};

/** The ffmpeg the launcher installed: `{ version, asset, installedAt }` or null. */
function ffmpegBundled() {
	const hasExe = (name) =>
		fs.existsSync(path.join(FFMPEG_DIR, `${name}.exe`)) ||
		fs.existsSync(path.join(FFMPEG_DIR, name));
	if (!hasExe("ffmpeg") || !hasExe("ffprobe")) return null;
	try {
		return JSON.parse(fs.readFileSync(FFMPEG_META, "utf8"));
	} catch {
		return { version: "", asset: "", installedAt: 0 };
	}
}

/** Whether ffmpeg and ffprobe answer from PATH (looked up at most once a minute). */
function ffmpegOnPath({ force = false } = {}) {
	if (
		force ||
		Date.now() - ffmpegState.systemCheckedAt > FFMPEG_SYSTEM_CACHE_MS
	) {
		const answers = (cmd) => {
			try {
				return (
					spawnSync(cmd, ["-version"], {
						stdio: "ignore",
						windowsHide: true,
						timeout: 10_000,
					}).status === 0
				);
			} catch {
				return false;
			}
		};
		ffmpegState.system = answers("ffmpeg") && answers("ffprobe");
		ffmpegState.systemCheckedAt = Date.now();
	}
	return ffmpegState.system;
}

function ffmpegInfo() {
	const bundled = ffmpegBundled();
	const system = !bundled && ffmpegOnPath();
	const installed = Boolean(bundled) || system;
	let text;
	if (ffmpegState.installing || ffmpegState.failed) {
		text = ffmpegState.stage;
	} else if (bundled) {
		const version = bundled.version ? ` ${bundled.version}` : "";
		text = tr(
			`ffmpeg${version} установлен — видео .mp4 и .mov конвертируются при загрузке.`,
			`ffmpeg${version} is installed — .mp4 and .mov videos are converted on upload.`,
		);
	} else if (system) {
		text = tr(
			"ffmpeg найден в системе — видео .mp4 и .mov конвертируются при загрузке.",
			"ffmpeg is found on this system — .mp4 and .mov videos are converted on upload.",
		);
	} else if (!IS_ELEVATED) {
		text = tr(
			"ffmpeg не установлен: загруженные .mp4 и .mov не конвертируются. Для установки Windows попросит права администратора.",
			"ffmpeg is not installed: uploaded .mp4 and .mov cannot be converted. To install it, Windows asks for administrator rights.",
		);
	} else {
		text = tr(
			"ffmpeg не установлен: загруженные .mp4 и .mov не конвертируются (видеослой играет только .webm).",
			"ffmpeg is not installed: uploaded .mp4 and .mov cannot be converted (a video layer plays .webm only).",
		);
	}
	return {
		installed,
		source: bundled ? "launcher" : system ? "system" : "",
		version: bundled?.version ?? "",
		dir: FFMPEG_DIR,
		canInstall:
			!installed &&
			!ffmpegState.installing &&
			(process.platform === "win32" || Boolean(FFMPEG_URL_OVERRIDE)),
		installing: ffmpegState.installing,
		progress: ffmpegState.progress,
		failed: ffmpegState.failed,
		needsAdmin: !IS_ELEVATED,
		text: say(text),
	};
}

function megabytes(bytes) {
	return (bytes / 1024 / 1024).toFixed(0);
}

/** The archive to download: `{ url, name, version, sha256 }` (sha256 may be ""). */
async function pickFfmpegArchive() {
	if (FFMPEG_URL_OVERRIDE) {
		return {
			url: FFMPEG_URL_OVERRIDE,
			name: path.basename(new URL(FFMPEG_URL_OVERRIDE).pathname),
			version: "",
			sha256: process.env.NOTGT_FFMPEG_SHA256 ?? "",
		};
	}
	const headers = { "User-Agent": `notGT-launcher/${VERSION}` };
	let name = FFMPEG_FALLBACK_ASSET;
	let version = "master";
	try {
		const res = await fetch(FFMPEG_RELEASE_API, {
			headers: { ...headers, Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(20_000),
		});
		if (res.ok) {
			const release = await res.json();
			let best = null;
			for (const asset of release.assets ?? []) {
				const match =
					/^ffmpeg-n(\d+)\.(\d+)-latest-win64-lgpl-shared-[\d.]+\.zip$/.exec(
						asset.name ?? "",
					);
				if (!match) continue;
				const rank = Number(match[1]) * 1000 + Number(match[2]);
				if (!best || rank > best.rank)
					best = { rank, name: asset.name, version: `${match[1]}.${match[2]}` };
			}
			if (best) {
				name = best.name;
				version = best.version;
			}
		}
	} catch {
		// The fallback archive below is in the same release.
	}
	let sha256 = "";
	try {
		const res = await fetch(`${FFMPEG_DOWNLOAD_BASE}checksums.sha256`, {
			headers,
			signal: AbortSignal.timeout(20_000),
		});
		if (res.ok) {
			for (const line of (await res.text()).split("\n")) {
				const [hash, file] = line.trim().split(/\s+/);
				if (file === name && /^[0-9a-f]{64}$/i.test(hash))
					sha256 = hash.toLowerCase();
			}
		}
	} catch {
		// Checked below: an archive with no checksum is not installed.
	}
	if (!sha256) {
		throw new Error(
			T(
				"не удалось получить контрольную сумму архива с GitHub",
				"the archive's checksum could not be fetched from GitHub",
			),
		);
	}
	return { url: `${FFMPEG_DOWNLOAD_BASE}${name}`, name, version, sha256 };
}

/** Streams `url` into `file`, reporting progress, and returns the SHA-256. */
async function downloadTo(url, file, onProgress) {
	const res = await fetch(url, {
		headers: { "User-Agent": `notGT-launcher/${VERSION}` },
		signal: AbortSignal.timeout(30 * 60_000),
	});
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} — ${url}`);
	const total = Number(res.headers.get("content-length")) || 0;
	const hash = crypto.createHash("sha256");
	let received = 0;
	// A pipeline: an error of the file (a full disk, an antivirus) rejects
	// here instead of being an unhandled "error" event that ends the process.
	await pipeline(
		Readable.fromWeb(res.body),
		new Transform({
			transform(chunk, _encoding, done) {
				hash.update(chunk);
				received += chunk.length;
				onProgress(received, total);
				done(null, chunk);
			},
		}),
		fs.createWriteStream(file),
	);
	return hash.digest("hex");
}

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * Takes `<top>/bin/*` (but ffplay) and `<top>/LICENSE.txt` out of a zip
 * archive into `dir`, flat. A plain reader of the zip format with
 * `zlib.inflateRaw`: Node has no unzip of its own, and Windows' tar.exe is
 * not on every Windows 10.
 *
 * Asynchronous all the way: the archive is ~75 MB and unpacks to ~150 MB,
 * which Windows Defender scans file by file as it is written. Done in one
 * go, that held the event loop long enough for the window's polls to go
 * unanswered and the idle exit to end the process.
 */
async function unzipFfmpeg(zipFile, dir, onEntry) {
	const zip = await fsp.readFile(zipFile);
	const bad = (why) =>
		new Error(T(`архив повреждён (${why})`, `the archive is damaged (${why})`));
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw bad("no end of central directory");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	if (count === 0xffff || at === 0xffffffff) throw bad("zip64");
	const wanted = [];
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw bad("central directory");
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const packed = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLen = zip.readUInt16LE(at + 28);
		const extraLen = zip.readUInt16LE(at + 30);
		const commentLen = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
		at += 46 + nameLen + extraLen + commentLen;
		const parts = name.split("/");
		const base = parts.at(-1);
		const take =
			(parts.length === 3 &&
				parts[1] === "bin" &&
				/^[\w.+-]+$/.test(base) &&
				!/^ffplay(\.exe)?$/i.test(base)) ||
			(parts.length === 2 && base === "LICENSE.txt");
		if (take) wanted.push({ name: base, method, crc, packed, size, local });
	}
	if (!wanted.some((entry) => /^ffmpeg(\.exe)?$/i.test(entry.name)))
		throw bad("no bin/ffmpeg");
	await fsp.mkdir(dir, { recursive: true });
	let done = 0;
	for (const entry of wanted) {
		if (zip.readUInt32LE(entry.local) !== 0x04034b50) throw bad(entry.name);
		const start =
			entry.local +
			30 +
			zip.readUInt16LE(entry.local + 26) +
			zip.readUInt16LE(entry.local + 28);
		const raw = zip.subarray(start, start + entry.packed);
		let data;
		if (entry.method === 0) data = raw;
		else if (entry.method === 8) data = await inflateRaw(raw);
		else throw bad(`${entry.name}: method ${entry.method}`);
		if (data.length !== entry.size) throw bad(`${entry.name}: size`);
		if (typeof zlib.crc32 === "function" && zlib.crc32(data) !== entry.crc)
			throw bad(`${entry.name}: CRC`);
		await fsp.writeFile(path.join(dir, entry.name), data);
		onEntry?.(++done, wanted.length);
	}
	return wanted.length;
}

/**
 * Windows keeps a file that was just written busy for a moment (the
 * antivirus reads it): removing or renaming it then fails with EBUSY or
 * EPERM. Both are tried again for a while before giving up.
 */
const FS_RETRY = { maxRetries: 30, retryDelay: 300 };
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

async function renamePatiently(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			await fsp.rename(from, to);
			return;
		} catch (err) {
			if (!BUSY_CODES.has(err?.code) || attempt >= FS_RETRY.maxRetries)
				throw err;
			await delay(FS_RETRY.retryDelay);
		}
	}
}

/** Removes what an install leaves behind; a leftover is not worth an error. */
async function removeQuietly(target) {
	try {
		await fsp.rm(target, { recursive: true, force: true, ...FS_RETRY });
	} catch (err) {
		pushLog(
			`[launcher] ${T("Не удалось удалить", "Could not remove")} ${target}: ${err?.message ?? err}`,
		);
	}
}

/**
 * Downloads ffmpeg into FFMPEG_DIR: the newest LGPL build for Windows, checked
 * against the release's checksum, unpacked into FFMPEG_DIR. What it is
 * doing shows in `ffmpegInfo()` while it runs. It never rejects: whatever
 * goes wrong ends as `failed` with the reason, not as a crash.
 */
async function installFfmpeg() {
	ffmpegState.installing = true;
	ffmpegState.failed = false;
	ffmpegState.progress = 0;
	ffmpegState.stage = tr("Ищем сборку ffmpeg…", "Looking for an ffmpeg build…");
	const zipFile = `${FFMPEG_DIR}.download.zip`;
	const fresh = `${FFMPEG_DIR}.new`;
	try {
		const archive = await pickFfmpegArchive();
		pushLog(
			`[launcher] ${T("Загрузка ffmpeg", "Downloading ffmpeg")}: ${archive.url}`,
		);
		await fsp.mkdir(path.dirname(FFMPEG_DIR), { recursive: true });
		let lastPercent = -1;
		const sha256 = await downloadTo(archive.url, zipFile, (received, total) => {
			const percent = total ? Math.floor((received / total) * 100) : 0;
			if (percent === lastPercent) return;
			lastPercent = percent;
			ffmpegState.progress = total ? (received / total) * 0.9 : 0;
			ffmpegState.stage = total
				? tr(
						`Загрузка ffmpeg… ${percent} % (${megabytes(received)} из ${megabytes(total)} МБ)`,
						`Downloading ffmpeg… ${percent} % (${megabytes(received)} of ${megabytes(total)} MB)`,
					)
				: tr(
						`Загрузка ffmpeg… ${megabytes(received)} МБ`,
						`Downloading ffmpeg… ${megabytes(received)} MB`,
					);
		});
		if (archive.sha256 && sha256 !== archive.sha256) {
			throw new Error(
				T(
					"контрольная сумма архива не совпала — загрузка испорчена",
					"the archive's checksum does not match — the download is corrupt",
				),
			);
		}
		ffmpegState.progress = 0.9;
		ffmpegState.stage = tr("Распаковка ffmpeg…", "Unpacking ffmpeg…");
		await fsp.rm(fresh, { recursive: true, force: true, ...FS_RETRY });
		const files = await unzipFfmpeg(zipFile, fresh, (done, total) => {
			ffmpegState.progress = 0.9 + (done / total) * 0.09;
			ffmpegState.stage = tr(
				`Распаковка ffmpeg… ${done} из ${total}`,
				`Unpacking ffmpeg… ${done} of ${total}`,
			);
		});
		await fsp.writeFile(
			path.join(fresh, "notgt-ffmpeg.json"),
			`${JSON.stringify(
				{
					version: archive.version,
					asset: archive.name,
					sha256,
					installedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
		);
		await fsp.rm(FFMPEG_DIR, { recursive: true, force: true, ...FS_RETRY });
		await renamePatiently(fresh, FFMPEG_DIR);
		ffmpegState.progress = 1;
		ffmpegState.stage = null;
		pushLog(
			`[launcher] ${T("ffmpeg установлен", "ffmpeg is installed")}: ${FFMPEG_DIR} (${files} ${T("файлов", "files")})`,
		);
	} catch (err) {
		const denied = ["EPERM", "EACCES", "EROFS"].includes(err?.code);
		const why = denied
			? T(
					`нет прав на запись в ${path.dirname(FFMPEG_DIR)}`,
					`no permission to write to ${path.dirname(FFMPEG_DIR)}`,
				)
			: String(err?.message ?? err);
		ffmpegState.failed = true;
		ffmpegState.stage = denied
			? tr(
					`Не удалось установить ffmpeg: ${why}. Нажмите ещё раз и разрешите запрос Windows — или установите ffmpeg сами (winget install Gyan.FFmpeg) и перезапустите сервер.`,
					`ffmpeg could not be installed: ${why}. Press again and allow the Windows prompt — or install ffmpeg yourself (winget install Gyan.FFmpeg) and restart the server.`,
				)
			: tr(
					`Не удалось установить ffmpeg: ${why}. Проверьте интернет и нажмите ещё раз — или установите ffmpeg сами (winget install Gyan.FFmpeg) и перезапустите сервер.`,
					`ffmpeg could not be installed: ${why}. Check the internet connection and press again — or install ffmpeg yourself (winget install Gyan.FFmpeg) and restart the server.`,
				);
		pushLog(`[launcher] ${say(ffmpegState.stage)}`);
		await removeQuietly(fresh);
	} finally {
		await removeQuietly(zipFile);
		ffmpegState.installing = false;
	}
}

/** Quotes for PowerShell: a single-quoted string, its quotes doubled. */
function psQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Without administrator rights: the install runs in a copy of this script
 * started through UAC (`--install-ffmpeg <status file>`), which reports how
 * far it is in that file; this process shows it as its own. The command goes
 * to PowerShell as UTF-16, so a folder with Cyrillic in its name gets there
 * whole (a .cmd file would not).
 */
async function installFfmpegElevated() {
	ffmpegState.installing = true;
	ffmpegState.failed = false;
	ffmpegState.progress = 0;
	ffmpegState.stage = tr(
		"Разрешите установку в запросе Windows (права администратора)…",
		"Allow the install in the Windows prompt (administrator rights)…",
	);
	const statusFile = path.join(
		os.tmpdir(),
		`notgt-ffmpeg-${process.pid}-${Date.now()}.json`,
	);
	const workerArgs = [
		fileURLToPath(import.meta.url),
		"--install-ffmpeg",
		statusFile,
		"--ffmpeg-dir",
		FFMPEG_DIR,
		"--lang",
		lang,
	];
	let seenLines = 0;
	let status = null;
	const readStatus = () => {
		try {
			status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
		} catch {
			return; // not written yet
		}
		ffmpegState.progress = status.progress ?? 0;
		if (status.stage) ffmpegState.stage = status.stage;
		for (const line of (status.log ?? []).slice(seenLines)) pushLog(line);
		seenLines = Math.max(seenLines, status.log?.length ?? 0);
	};
	try {
		const code = await new Promise((resolve) => {
			if (ELEVATE_OVERRIDE === "decline") {
				resolve(1);
				return;
			}
			const argLine = workerArgs.map((arg) => `"${arg}"`).join(" ");
			const child =
				ELEVATE_OVERRIDE === "direct"
					? spawn(process.execPath, workerArgs, {
							stdio: "ignore",
							windowsHide: true,
						})
					: spawn(
							"powershell",
							[
								"-NoProfile",
								"-NonInteractive",
								// Base64 of UTF-16: no quoting between here and PowerShell
								// can bend a quote or a Cyrillic path on the way.
								"-EncodedCommand",
								Buffer.from(
									`$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argLine)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
									"utf16le",
								).toString("base64"),
							],
							{ stdio: "ignore", windowsHide: true },
						);
			const timer = setInterval(readStatus, 400);
			child.once("error", () => {
				clearInterval(timer);
				resolve(-1);
			});
			child.once("close", (exitCode) => {
				clearInterval(timer);
				resolve(exitCode ?? -1);
			});
		});
		readStatus();
		if (status?.done) {
			ffmpegState.failed = Boolean(status.failed);
			ffmpegState.stage = status.failed ? status.stage : null;
			if (!status.failed) ffmpegState.progress = 1;
		} else {
			// The worker never ran: the prompt was refused (or did not come up).
			ffmpegState.failed = true;
			ffmpegState.stage = tr(
				`Права администратора не получены — ffmpeg не установлен. Нажмите ещё раз и разрешите запрос Windows (код ${code}).`,
				`Administrator rights were not given — ffmpeg is not installed. Press again and allow the Windows prompt (code ${code}).`,
			);
			pushLog(`[launcher] ${say(ffmpegState.stage)}`);
		}
	} finally {
		ffmpegState.installing = false;
		await removeQuietly(statusFile);
	}
}

/**
 * The elevated copy: installs, writing its progress (and its log lines) to
 * the status file the launcher reads, and ends.
 */
async function runFfmpegWorker(statusFile) {
	const log = [];
	logSink = (line) => log.push(line);
	const write = (done = false) => {
		const status = {
			progress: ffmpegState.progress,
			stage: ffmpegState.stage,
			failed: ffmpegState.failed,
			done,
			log,
		};
		try {
			// Whole or not at all: the launcher may read it at any moment.
			fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify(status));
			fs.renameSync(`${statusFile}.tmp`, statusFile);
		} catch {
			/* the launcher shows the last status it could read */
		}
	};
	const timer = setInterval(write, 300);
	await installFfmpeg();
	clearInterval(timer);
	write(true);
	return ffmpegState.failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Map a bind host to a host that can actually be dialled from this machine. */
function openHostFor(host) {
	if (host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0")
		return "127.0.0.1";
	return host;
}

/** Format a host for use inside a URL (IPv6 needs brackets). */
function urlHost(host) {
	const h = openHostFor(host);
	return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

function guiUrlFor(host, port) {
	return `http://${urlHost(host)}:${port}/dashboard/`;
}

const ANY_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

function isAnyHost(host) {
	return ANY_HOSTS.has(host);
}

function isLoopbackHost(host) {
	return host === "127.0.0.1" || host === "::1";
}

/**
 * NodeCG's own default is "listen everywhere", and that is what we keep for
 * every choice except the explicit loopback one.
 *
 * Binding a single network card is what makes Windows Firewall drop *even
 * same-machine* connections to that address, and it leaves 127.0.0.1 with no
 * listener at all - so the launcher could no longer prove that the server is
 * alive while the chosen address stays silent. The dropdown therefore decides
 * the *advertised* address (links + probe), not the bind address.
 */
function bindHostFor(host) {
	if (isLoopbackHost(host)) return "127.0.0.1";
	return net.isIPv6(host) ? "::" : "0.0.0.0";
}

/**
 * Interface names that are normally *not* the address an operator should hand
 * to another device: Docker/WSL/Hyper-V/VirtualBox bridges and tunnels.
 */
const VIRTUAL_IFACE =
	/(docker|veth|bridge|br-|virbr|vmnet|vbox|virtualbox|host-only|hyper-?v|vethernet|wsl|loopback|tailscale|zerotier|zt[0-9a-f]+|tun[0-9]|tap[0-9]|utun|teredo|isatap)/i;

function ifaceIsVirtual(name) {
	return VIRTUAL_IFACE.test(name);
}

/**
 * Prefer an address that is reachable from the studio LAN: a real card, an IPv4
 * address, and a private range in the usual order of likelihood.
 */
function addressScore(entry) {
	let score = 0;
	if (entry.virtual) score -= 100;
	if (entry.family === "IPv4") score += 20;
	const addr = entry.address;
	if (/^169\.254\./.test(addr)) score -= 80;
	if (/^192\.168\./.test(addr)) score += 30;
	else if (/^10\./.test(addr)) score += 20;
	else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr)) score += 10;
	return score;
}

/** The best real network address of this machine, for "all interfaces". */
function primaryAddress() {
	const candidates = listInterfaces().filter(
		(iface) => iface.address !== "0.0.0.0" && iface.address !== "127.0.0.1",
	);
	if (candidates.length === 0) return null;
	candidates.sort(
		(a, b) =>
			addressScore(b) - addressScore(a) ||
			(a.family === "IPv4" ? -1 : 1) - (b.family === "IPv4" ? -1 : 1),
	);
	return candidates[0].address;
}

/** The address that goes into links, and the one the launcher probes. */
function advertiseHostFor(host) {
	if (isAnyHost(host)) return primaryAddress() ?? "127.0.0.1";
	return host;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * The launcher speaks Russian and English. Which one is chosen in its window
 * (or on its page), kept in launcher-config.json, and until someone chooses it
 * is the language of the system.
 *
 * A text that is shown later than it is made — the status, a warning — is
 * kept in both languages (`tr`) and only becomes one of them when it is sent
 * (`say`), so switching the language changes what is already on screen. A
 * text that is the answer to a request is made in the current language at
 * once (`T`).
 */
const LANGS = ["ru", "en"];
let lang = "en";

function isLang(value) {
	return LANGS.includes(value);
}

function systemLang() {
	const locale =
		Intl.DateTimeFormat().resolvedOptions().locale ||
		process.env.LC_ALL ||
		process.env.LANG ||
		"";
	return locale.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function tr(ru, en) {
	return { ru, en };
}

function say(text, to = lang) {
	if (text === null || text === undefined) return "";
	return typeof text === "string" ? text : (text[to] ?? text.en ?? "");
}

function T(ru, en) {
	return lang === "ru" ? ru : en;
}

/** Several texts as one, in both languages. */
function joined(parts, separator = " ") {
	return tr(
		parts.map((part) => say(part, "ru")).join(separator),
		parts.map((part) => say(part, "en")).join(separator),
	);
}

/** Turns a log tail into a concrete, actionable hint when we can recognise it. */
function hintForLogTail(tail) {
	const text = tail || "";
	if (/EADDRINUSE/i.test(text)) {
		return tr(
			"Похоже, порт уже занят другим процессом — выберите другой порт.",
			"The port seems to be taken by another process — choose another port.",
		);
	}
	if (/NODE_MODULE_VERSION|compiled against a different Node/i.test(text)) {
		return tr(
			"Нативный модуль собран под другую версию Node. Пересоберите пакет тем же " +
				"Node.js, который лежит в папке node\\.",
			"A native module was built for another version of Node. Rebuild the package " +
				"with the same Node.js that is in the node\\ folder.",
		);
	}
	if (/Cannot find module/i.test(text)) {
		return tr(
			"Сервер не нашёл модуль: скорее всего архив распакован не полностью. " +
				"Распакуйте ZIP целиком в пустую папку.",
			"The server could not find a module: most likely the archive was not unpacked " +
				"completely. Unpack the whole ZIP into an empty folder.",
		);
	}
	if (/EACCES|EPERM/i.test(text)) {
		return tr(
			"Нет прав на запись. Не запускайте из Program Files и не распаковывайте " +
				"в системные папки.",
			"No permission to write. Do not run it from Program Files or unpack it " +
				"into system folders.",
		);
	}
	if (/ENOENT/i.test(text) && /(cfg|nodecg\.json|SQLITE|sqlite)/i.test(text)) {
		return tr(
			"Не читается app\\cfg или app\\db — проверьте, что папки распакованы.",
			"app\\cfg or app\\db cannot be read — check that the folders were unpacked.",
		);
	}
	return null;
}

/**
 * Explains a failed start instead of just saying "no answer".
 * Only reached when *nothing* answered (neither the advertised address nor
 * loopback), so it looks for the classic reasons: a port clash, a crash, or a
 * second instance already running on the default port.
 */
async function startFailureReport(host, port, bindHost, tail) {
	const dialHost = openHostFor(host);
	const seconds = Math.round(READY_TIMEOUT_MS / 1000);
	const parts = [
		tr(
			`Сервер не ответил за ${seconds} с (проверяли ${dialHost}:${port} и 127.0.0.1:${port}).`,
			`The server did not answer within ${seconds} s (tried ${dialHost}:${port} and 127.0.0.1:${port}).`,
		),
	];

	const onChosen =
		dialHost === "127.0.0.1" ? false : await probeHttp(host, port);
	const onLoopback = await probeHttp("127.0.0.1", port);
	if (onChosen && !onLoopback) {
		parts.push(
			tr(
				`При этом ${dialHost}:${port} отвечает — похоже, сервер слушает только этот ` +
					`адрес (так было в старых сборках). Перезапустите лончер.`,
				`Yet ${dialHost}:${port} answers — the server seems to listen on that address ` +
					`only (as older builds did). Restart the launcher.`,
			),
		);
	}
	if (onLoopback && !onChosen) {
		parts.push(
			tr(
				`При этом на 127.0.0.1:${port} он отвечает, а на ${dialHost}:${port} — нет: ` +
					`обычно это брандмауэр. Нажмите «Проверить доступность» / «Разрешить порт».`,
				`Yet it answers on 127.0.0.1:${port} and not on ${dialHost}:${port}: usually ` +
					`that is the firewall. Press “Check” / “Allow the port”.`,
			),
		);
	}
	if (bindHost && bindHost !== dialHost) {
		parts.push(
			tr(
				`Сервер должен был слушать ${bindHost}:${port}.`,
				`The server was to listen on ${bindHost}:${port}.`,
			),
		);
	}

	if (port !== DEFAULT_PORT && (await probeHttp("127.0.0.1", DEFAULT_PORT))) {
		parts.push(
			tr(
				`Порт ${DEFAULT_PORT} при этом отвечает: возможно, сервер поднялся на нём, а не ` +
					`на выбранном ${port} (тогда проверьте app\\cfg\\nodecg.json), либо на ` +
					`${DEFAULT_PORT} уже запущен другой экземпляр NodeCG.`,
				`Port ${DEFAULT_PORT} answers meanwhile: the server may have come up on it ` +
					`instead of the chosen ${port} (then check app\\cfg\\nodecg.json), or another ` +
					`NodeCG is already running on ${DEFAULT_PORT}.`,
			),
		);
	}

	const hint = hintForLogTail(tail);
	if (hint) parts.push(hint);
	parts.push(
		tr("Последние строки журнала:", "The last lines of the log:"),
		tail || tr("(журнал пуст)", "(the log is empty)"),
	);
	return joined(parts, "\n");
}

function isValidPort(value) {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

// ---------------------------------------------------------------------------
// Network interfaces
// ---------------------------------------------------------------------------

/**
 * Build the interface list for the UI.
 * The two synthetic entries come first (spec: "Все интерфейсы" / "Только этот компьютер").
 * Internal addresses are skipped (loopback is covered by the synthetic entry) and
 * IPv6 link-local noise (fe80::/10) is dropped.
 */
function listInterfaces() {
	const list = [
		{
			id: "0.0.0.0",
			label: T("Все интерфейсы (0.0.0.0)", "All interfaces (0.0.0.0)"),
			address: "0.0.0.0",
			family: "IPv4",
			internal: false,
		},
		{
			id: "127.0.0.1",
			label: T(
				"Только этот компьютер (127.0.0.1)",
				"This computer only (127.0.0.1)",
			),
			address: "127.0.0.1",
			family: "IPv4",
			internal: true,
		},
	];

	// Real network cards first, virtual adapters last: on Windows the OS often
	// lists vEthernet/WSL/VirtualBox addresses before Wi-Fi, and picking one of
	// those is a reliable way to end up with an unreachable address.
	const nics = os.networkInterfaces();
	const real = [];
	const virtual = [];
	for (const [name, addresses] of Object.entries(nics)) {
		for (const addr of addresses ?? []) {
			if (addr.internal) continue; // ::1 / 127.x handled by the synthetic localhost entry
			const isV4 = addr.family === "IPv4" || addr.family === 4;
			const family = isV4 ? "IPv4" : "IPv6";
			if (!isV4 && /^fe80:/i.test(addr.address)) continue; // link-local noise
			const entry = {
				id: addr.address,
				label: `${name} — ${addr.address}`,
				address: addr.address,
				family,
				internal: false,
			};
			if (ifaceIsVirtual(name)) {
				entry.label += T(" (виртуальный)", " (virtual)");
				entry.virtual = true;
				virtual.push(entry);
			} else {
				real.push(entry);
			}
		}
	}
	const byScore = (a, b) => addressScore(b) - addressScore(a);
	real.sort(byScore);
	virtual.sort(byScore);
	return [...list, ...real, ...virtual];
}

function defaultHost() {
	// Listen on every interface by default, exactly like NodeCG itself does.
	// Binding a single card is what makes Windows Firewall block even
	// same-machine connections, and it leaves 127.0.0.1 without a listener -
	// so "the server never answered" was the only thing we could report.
	return "0.0.0.0";
}

// ---------------------------------------------------------------------------
// Persisted launcher settings (last chosen host/port)
// ---------------------------------------------------------------------------

function readPersisted() {
	try {
		const parsed = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf8"));
		if (parsed && typeof parsed === "object") {
			return {
				host: typeof parsed.host === "string" ? parsed.host : null,
				port: isValidPort(parsed.port) ? parsed.port : null,
				lang: isLang(parsed.lang) ? parsed.lang : null,
			};
		}
	} catch {
		/* missing or corrupt -> ignore */
	}
	return { host: null, port: null, lang: null };
}

function persistSettings(host, port) {
	try {
		fs.writeFileSync(
			PERSIST_PATH,
			JSON.stringify({ host, port, lang }, null, 2) + "\n",
			"utf8",
		);
	} catch {
		/* ignore write failures - persistence is best effort */
	}
}

// ---------------------------------------------------------------------------
// Launcher state
// ---------------------------------------------------------------------------

const persisted = readPersisted();
lang = isLang(args.lang) ? args.lang : (persisted.lang ?? systemLang());

const state = {
	host: args.host ?? persisted.host ?? defaultHost(),
	port: isValidPort(args.port) ? args.port : (persisted.port ?? DEFAULT_PORT),
	status: "stopped", // stopped | starting | running | stopping | error
	statusText: tr("Сервер не запущен.", "The server is not running."),
	warning: "", // set when the server is up but unreachable on the chosen address
	reach: null, // last { dialHost, port, chosenOk, loopbackOk }
	child: null,
	sender: null, // the NDI sender, while the server runs
	logs: [], // ring buffer of the last LOG_BUFFER_MAX lines
	logCount: 0, // total number of lines ever produced (monotonic)
};

/** Where log lines also go: the elevated ffmpeg installer collects them. */
let logSink = null;

function pushLog(line) {
	logSink?.(line);
	state.logs.push(line);
	state.logCount++;
	if (state.logs.length > LOG_BUFFER_MAX) state.logs.shift();
}

/** The first buffer index currently held (accounts for ring trimming). */
function bufferStart() {
	return state.logCount - state.logs.length;
}

/**
 * The three URLs of the current selection.
 *
 * `guiUrl` is what «Открыть GUI» uses: for "all interfaces" that stays 127.0.0.1
 * (it can never be blocked), for a concrete card it is that card - unless we
 * already know the card is silent, in which case loopback is used so the
 * operator is not locked out of their own dashboard.
 */
function guiUrls() {
	const loopbackUrl = `http://127.0.0.1:${state.port}/dashboard/`;
	const networkUrl = guiUrlFor(currentAdvertiseHost(), state.port);
	const preferred = isAnyHost(state.host) ? loopbackUrl : networkUrl;
	const blocked =
		state.reach !== null &&
		state.reach !== undefined &&
		!state.reach.chosenOk &&
		state.reach.loopbackOk;
	return {
		guiUrl: blocked ? loopbackUrl : preferred,
		networkUrl,
		loopbackUrl,
		guiUrlFallback: blocked && !isAnyHost(state.host),
	};
}

/** The URL that is actually usable right now (falls back to loopback). */
function effectiveGuiUrl() {
	return guiUrls().guiUrl;
}

function statePayload() {
	const urls = guiUrls();
	return {
		version: VERSION,
		appDir,
		nodeVersion: process.version,
		platform: process.platform,
		host: state.host,
		bindHost: state.bindHost ?? bindHostFor(state.host),
		advertiseHost: currentAdvertiseHost(),
		port: state.port,
		status: state.status,
		lang,
		statusText: say(state.statusText),
		running: state.status === "running",
		warning: say(state.warning),
		reach: state.reach,
		firewall: firewallInfo(state.port),
		...urls,
		configPath: path.join(appDir, "cfg", "nodecg.json"),
		login: loginInfo(),
		ffmpeg: ffmpegInfo(),
		interfaces: listInterfaces(),
		logs: state.logs.slice(),
		logCount: state.logCount,
	};
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

/** Pipe a child stream into the ring buffer, splitting on newlines. */
function attachLogs(child) {
	const consume = (stream) => {
		let partial = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			partial += chunk;
			let idx;
			while ((idx = partial.indexOf("\n")) >= 0) {
				pushLog(partial.slice(0, idx).replace(/\r$/, ""));
				partial = partial.slice(idx + 1);
			}
		});
		stream.on("end", () => {
			if (partial) {
				pushLog(partial.replace(/\r$/, ""));
				partial = "";
			}
		});
	};
	if (child.stdout) consume(child.stdout);
	if (child.stderr) consume(child.stderr);
}

/** Try to bind host:port to see whether it is free. */
function checkPortFree(host, port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", (err) =>
			resolve({ ok: false, code: err.code, message: err.message }),
		);
		probe.once("listening", () => probe.close(() => resolve({ ok: true })));
		try {
			probe.listen({ host, port, exclusive: true });
		} catch (err) {
			resolve({ ok: false, code: err.code, message: err.message });
		}
	});
}

/** Any HTTP response - even an error page - means NodeCG is answering. */
function probeHttp(host, port) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let req;
		try {
			req = http.get(
				{ host: openHostFor(host), port, path: "/", timeout: 2000 },
				(res) => {
					res.resume();
					done(true);
				},
			);
		} catch {
			done(false);
			return;
		}
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
	});
}

// ---------------------------------------------------------------------------
// Reachability: "is the server up?" vs "can anyone actually get to it?"
// ---------------------------------------------------------------------------

/**
 * Probe both the address the user chose and loopback.
 *
 * Binding a single network card is what makes Windows Firewall drop even
 * same-machine connections to that address ("бесконечная загрузка" in the
 * browser, and the readiness probe never passing). Telling those two states
 * apart is the whole point of this function.
 */
async function measureReach(host, port, { loopbackOnly = false } = {}) {
	const dialHost = openHostFor(host);
	const direct = dialHost === "127.0.0.1" || dialHost === "::1";
	const chosenOk = await probeHttp(host, port);
	const loopbackOk = direct ? chosenOk : await probeHttp("127.0.0.1", port);
	return {
		host,
		dialHost,
		port,
		loopbackOnly: loopbackOnly || direct,
		chosenOk,
		loopbackOk,
	};
}

/** The advertised address of the current selection (never `0.0.0.0`). */
function currentAdvertiseHost() {
	return state.advertiseHost ?? advertiseHostFor(state.host);
}

function measureCurrentReach() {
	return measureReach(currentAdvertiseHost(), state.port, {
		loopbackOnly: isLoopbackHost(state.host),
	});
}

// ---------------------------------------------------------------------------
// Windows firewall (best effort, never fatal)
// ---------------------------------------------------------------------------

/** Rule names must not contain spaces: netsh re-parses its raw command line. */
function firewallRuleName(port) {
	return `notGT-NodeCG-TCP-${port}`;
}

function firewallSupported() {
	return process.platform === "win32";
}

function runSync(cmd, args) {
	let res;
	try {
		res = spawnSync(cmd, args, {
			encoding: "utf8",
			windowsHide: true,
			timeout: 20_000,
		});
	} catch (err) {
		return { ok: false, status: null, out: "", error: err.message };
	}
	return {
		ok: !res.error && res.status === 0,
		status: res.status,
		out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
		error: res.error ? res.error.message : "",
	};
}

const firewallCache = new Map(); // port -> { exists, at }

/**
 * Does an inbound allow rule for this port already exist?
 * The `netsh` output is localized, but our own rule name is not, so a plain
 * substring check works on any Windows display language.
 */
function firewallRuleExists(port, { force = false } = {}) {
	if (!firewallSupported()) return false;
	const cached = firewallCache.get(port);
	if (!force && cached && Date.now() - cached.at < FIREWALL_CACHE_MS)
		return cached.exists;
	const name = firewallRuleName(port);
	const res = runSync("netsh", [
		"advfirewall",
		"firewall",
		"show",
		"rule",
		`name=${name}`,
		"dir=in",
	]);
	const exists = res.out.includes(name);
	firewallCache.set(port, { exists, at: Date.now() });
	return exists;
}

function firewallInfo(port) {
	const supported = firewallSupported();
	return {
		supported,
		port,
		ruleName: firewallRuleName(port),
		ruleExists: supported ? firewallRuleExists(port) : false,
	};
}

/**
 * Run a netsh command elevated (UAC). The command goes into a throwaway .cmd
 * file so that no layer of cmd/PowerShell/netsh quoting can mangle it.
 */
function runElevated(command) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-fw-"));
	const file = path.join(dir, "firewall.cmd");
	try {
		fs.writeFileSync(file, `@echo off\r\n${command}\r\n`, "utf8");
		return runSync("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$p = Start-Process -FilePath '${file}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
		]);
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Add an inbound allow rule for the port, for every network profile.
 * First try unelevated (works if the launcher already has admin rights), then
 * fall back to a UAC prompt, then *verify* - the exit code of an elevated
 * helper is not worth trusting when a plain query can answer directly.
 */
function addFirewallRule(port) {
	if (!firewallSupported()) {
		return {
			ok: false,
			message: T(
				"Управление брандмауэром доступно только в Windows. Проверьте " +
					"брандмауэр системы вручную.",
				"The firewall can only be managed on Windows. Check the system's " +
					"firewall by hand.",
			),
		};
	}
	const name = firewallRuleName(port);
	if (firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: true,
			message: T("Правило уже существует.", "The rule already exists."),
		};
	}
	const direct = runSync("netsh", [
		"advfirewall",
		"firewall",
		"add",
		"rule",
		`name=${name}`,
		"dir=in",
		"action=allow",
		`protocol=TCP`,
		`localport=${port}`,
		"profile=any",
	]);
	if (firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: false,
			message: T("Правило добавлено.", "The rule was added."),
		};
	}
	const elevated = runElevated(
		`netsh advfirewall firewall add rule name=${name} dir=in action=allow protocol=TCP localport=${port} profile=any`,
	);
	if (firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: false,
			message: T(
				"Правило добавлено (с правами администратора).",
				"The rule was added (with administrator rights).",
			),
		};
	}
	return {
		ok: false,
		message: T(
			"Не удалось добавить правило. Если запрос UAC был отклонён — нажмите " +
				`кнопку ещё раз и подтвердите. Ответ системы: ${(elevated.out || direct.out || direct.error || "нет").trim().slice(0, 300)}`,
			"The rule could not be added. If the UAC prompt was declined, press the " +
				`button again and confirm. The system said: ${(elevated.out || direct.out || direct.error || "nothing").trim().slice(0, 300)}`,
		),
	};
}

function removeFirewallRule(port) {
	if (!firewallSupported()) {
		return {
			ok: false,
			message: T(
				"Управление брандмауэром доступно только в Windows.",
				"The firewall can only be managed on Windows.",
			),
		};
	}
	if (!firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: false,
			message: T("Правила и так нет.", "There is no rule to remove."),
		};
	}
	const name = firewallRuleName(port);
	runSync("netsh", [
		"advfirewall",
		"firewall",
		"delete",
		"rule",
		`name=${name}`,
	]);
	if (!firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: true,
			message: T("Правило удалено.", "The rule was removed."),
		};
	}
	runElevated(`netsh advfirewall firewall delete rule name=${name}`);
	if (!firewallRuleExists(port, { force: true })) {
		return {
			ok: true,
			existed: true,
			message: T(
				"Правило удалено (с правами администратора).",
				"The rule was removed (with administrator rights).",
			),
		};
	}
	return {
		ok: false,
		message: T("Не удалось удалить правило.", "The rule could not be removed."),
	};
}

/**
 * A system-wide proxy makes the browser send http://192.168.x.x:9090 to the
 * proxy instead of to the local machine. Loopback is normally on the bypass
 * list, so "everything except 127.0.0.1 hangs" is the classic symptom.
 */
function readWindowsProxy() {
	if (!firewallSupported()) return null;
	const key =
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
	const read = (name) => {
		const res = runSync("reg", ["query", key, "/v", name]);
		const match = res.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, "i"));
		return match ? match[1].trim() : "";
	};
	const enabled = read("ProxyEnable") === "0x1";
	return {
		enabled,
		server: read("ProxyServer"),
		override: read("ProxyOverride"),
	};
}

/** Human-readable, actionable list for the chosen address. */
async function diagnose() {
	// Always measure afresh: this is what the user presses after changing a
	// firewall rule, so a cached answer would be actively misleading.
	const reach = await measureCurrentReach();
	const firewall = firewallInfo(state.port);
	const proxy = readWindowsProxy();
	const verdict = [];

	if (!state.child) {
		verdict.push({
			level: "info",
			text: T(
				"Сервер сейчас не запущен — сначала нажмите «Запустить».",
				"The server is not running — press “Start” first.",
			),
		});
	} else if (reach.chosenOk) {
		verdict.push({
			level: "ok",
			text: T(
				`Адрес ${reach.dialHost}:${reach.port} отвечает.`,
				`${reach.dialHost}:${reach.port} answers.`,
			),
		});
	} else if (reach.loopbackOk) {
		verdict.push({
			level: "warn",
			text: T(
				`Сервер работает: 127.0.0.1:${reach.port} отвечает, а ${reach.dialHost}:${reach.port} — нет.`,
				`The server is running: 127.0.0.1:${reach.port} answers, ${reach.dialHost}:${reach.port} does not.`,
			),
		});
		verdict.push({
			level: "warn",
			text: firewall.supported
				? firewall.ruleExists
					? T(
							`Правило «${firewall.ruleName}» есть, но пакеты всё равно не проходят: проверьте, что сеть в Windows помечена как «Частная», и разрешите node.exe входящие подключения.`,
							`The rule “${firewall.ruleName}” exists, yet nothing gets through: check that the network is marked “Private” in Windows, and allow node.exe incoming connections.`,
						)
					: T(
							"Входящие подключения режет брандмауэр Windows. Нажмите «Разрешить порт» — лончер добавит правило для всех профилей сети (потребуются права администратора).",
							"Windows Firewall is dropping incoming connections. Press “Allow the port” — the launcher adds a rule for every network profile (administrator rights are needed).",
						)
				: T(
						"Проверьте брандмауэр и маршрутизацию до этого адреса.",
						"Check the firewall and the route to this address.",
					),
		});
	} else {
		verdict.push({
			level: "error",
			text: T(
				`Сервер не отвечает ни на ${reach.dialHost}:${reach.port}, ни на 127.0.0.1:${reach.port}.`,
				`The server answers neither on ${reach.dialHost}:${reach.port} nor on 127.0.0.1:${reach.port}.`,
			),
		});
	}

	if (proxy && proxy.enabled && !reach.loopbackOnly) {
		const bypassed = (proxy.override || "")
			.split(";")
			.some((entry) => entry.trim() === reach.dialHost);
		if (!bypassed) {
			verdict.push({
				level: "warn",
				text: T(
					`В Windows включён прокси-сервер (${proxy.server || "адрес не указан"}). Браузер может отправлять запросы к ${reach.dialHost} через прокси — тогда страница грузится бесконечно. Добавьте адрес в исключения прокси или отключите прокси.`,
					`A proxy server is switched on in Windows (${proxy.server || "no address given"}). The browser may send requests to ${reach.dialHost} through it, and the page then never loads. Add the address to the proxy's exceptions or switch the proxy off.`,
				),
			});
		}
	}

	// Everything can answer locally and the port still be closed to the rest of
	// the studio: Windows Firewall governs inbound connections per program, so a
	// successful self-probe proves nothing about other devices.
	if (
		state.child &&
		firewall.supported &&
		!firewall.ruleExists &&
		!reach.loopbackOnly &&
		reach.chosenOk
	) {
		verdict.push({
			level: "info",
			text: T(
				`Правила брандмауэра для порта ${state.port} нет. С этого компьютера всё ` +
					`открывается, но другие устройства (OBS на второй машине, Bitfocus Companion, ` +
					`телефон) могут не подключиться. Нажмите «Разрешить порт» — правило будет ` +
					`создано для всех профилей сети.`,
				`There is no firewall rule for port ${state.port}. Everything opens from this ` +
					`computer, but other devices (OBS on a second machine, Bitfocus Companion, a ` +
					`phone) may fail to connect. Press “Allow the port” — the rule is made for ` +
					`every network profile.`,
			),
		});
	}

	return { reach, firewall, proxy, verdict };
}

/** Wait for a child to exit, up to `ms`. Returns true if it exited. */
function waitExit(child, ms) {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.removeListener("exit", onExit);
			resolve(false);
		}, ms);
		function onExit() {
			clearTimeout(timer);
			resolve(true);
		}
		child.once("exit", onExit);
	});
}

/**
 * Ask the child (and its whole tree) to terminate.
 * Windows: `taskkill /PID <pid> /T /F` is the only reliable way to kill a tree.
 * POSIX:   SIGTERM first; the caller escalates to SIGKILL after a grace period.
 */
function killTree(child) {
	if (process.platform === "win32") {
		try {
			const killer = spawn(
				"taskkill",
				["/PID", String(child.pid), "/T", "/F"],
				{
					stdio: "ignore",
					windowsHide: true,
				},
			);
			killer.on("error", () => {
				try {
					child.kill();
				} catch {
					/* already gone */
				}
			});
		} catch {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		}
		return Promise.resolve();
	}
	try {
		child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	return Promise.resolve();
}

/** Best-effort synchronous kill used from the `exit` handler. */
function hardKillChild() {
	hardKill(state.sender);
	hardKill(state.child);
}

function hardKill(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		/* ignore */
	}
}

/** cfg/nodecg.json as an object; a missing or invalid file is an empty one. */
function readNodecgConfig() {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(appDir, "cfg", "nodecg.json"), "utf8"),
		);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed;
	} catch {
		/* missing or invalid config: start from scratch */
	}
	return {};
}

/** Read + merge cfg/nodecg.json so every unrelated key is preserved. */
async function mergeNodecgConfig(patch) {
	const cfgDir = path.join(appDir, "cfg");
	const merged = { ...readNodecgConfig(), ...patch };
	await fsp.mkdir(cfgDir, { recursive: true });
	await fsp.writeFile(
		path.join(cfgDir, "nodecg.json"),
		JSON.stringify(merged, null, 2) + "\n",
		"utf8",
	);
}

function writeNodecgConfig(host, port) {
	return mergeNodecgConfig({ host, port });
}

// ---------------------------------------------------------------------------
// Sign-in (NodeCG's local login, kept in cfg/nodecg.json)
// ---------------------------------------------------------------------------

/**
 * Whether the team's default administrator (admin / admin) is still what gets
 * someone in: the bundle keeps the team in db/notGT-team.json and marks the
 * account until it is given a real password. No file yet means a server that
 * has not run — it will make that account on its first start.
 */
function defaultPasswordInUse() {
	try {
		const team = JSON.parse(
			fs.readFileSync(path.join(appDir, "db", "notGT-team.json"), "utf8"),
		);
		return (
			Array.isArray(team?.users) &&
			team.users.some((user) => user?.defaultPassword === true)
		);
	} catch (err) {
		return err?.code === "ENOENT";
	}
}

/**
 * Whether the dashboard asks for a password, and whose. Never the password.
 *
 * The sign-in is on unless cfg/nodecg.json switches it off. Without a `login`
 * block the users are the ones kept in the dashboard's Team tab (`team`);
 * with one, the operator written here is the administrator (`launcher`).
 */
function loginInfo() {
	const login = readNodecgConfig().login;
	if (login === undefined || login === null) {
		return {
			enabled: true,
			source: "team",
			username: null,
			defaultPassword: defaultPasswordInUse(),
		};
	}
	const users = login.local?.enabled ? login.local.allowedUsers : undefined;
	const enabled = Boolean(login.enabled && login.sessionSecret);
	return {
		enabled,
		source: enabled ? "launcher" : "off",
		username:
			enabled && Array.isArray(users) && typeof users[0]?.username === "string"
				? users[0].username
				: null,
		defaultPassword: false,
	};
}

/**
 * Switches the sign-in on for one operator. The password is not written down:
 * NodeCG accepts `sha256:<HMAC keyed with sessionSecret>` in its place.
 */
async function enableLogin(username, password) {
	const login = readNodecgConfig().login ?? {};
	const sessionSecret =
		typeof login.sessionSecret === "string" && login.sessionSecret
			? login.sessionSecret
			: crypto.randomBytes(32).toString("hex");
	const hash = crypto
		.createHmac("sha256", sessionSecret)
		.update(password, "utf8")
		.digest("hex");
	await mergeNodecgConfig({
		login: {
			...login,
			enabled: true,
			sessionSecret,
			local: {
				enabled: true,
				allowedUsers: [{ username, password: `sha256:${hash}` }],
			},
		},
	});
}

async function disableLogin() {
	// Written even when there was no block: its absence means "on".
	const login = readNodecgConfig().login ?? {};
	await mergeNodecgConfig({ login: { ...login, enabled: false } });
}

/** Back to the sign-in nobody configured: on, with the users of the Team tab. */
async function resetLogin() {
	const cfgDir = path.join(appDir, "cfg");
	const { login: _dropped, ...rest } = readNodecgConfig();
	await fsp.mkdir(cfgDir, { recursive: true });
	await fsp.writeFile(
		path.join(cfgDir, "nodecg.json"),
		JSON.stringify(rest, null, 2) + "\n",
		"utf8",
	);
}

/**
 * Only a real JSON request may change the sign-in. A web page of another
 * origin can post a "simple" body to 127.0.0.1 without asking, but not one
 * with this content type.
 */
function isJsonRequest(req) {
	return /^application\/json\b/i.test(req.headers["content-type"] ?? "");
}

/** What the UI shows after the sign-in was changed. */
function loginResult(message) {
	const running = Boolean(state.child);
	return {
		ok: true,
		login: loginInfo(),
		restart: running,
		message: running
			? `${message} ${T("Изменение вступит в силу после перезапуска сервера: «Остановить», затем «Запустить».", "It takes effect once the server is restarted: “Stop”, then “Start”.")}`
			: message,
	};
}

async function startServer(requestedHost, requestedPort) {
	if (
		state.status === "starting" ||
		state.status === "running" ||
		state.status === "stopping"
	) {
		return {
			http: 409,
			body: {
				...statePayload(),
				error: T(
					"Сервер уже запущен или запускается.",
					"The server is already running or starting.",
				),
			},
		};
	}

	const host =
		typeof requestedHost === "string" && requestedHost.trim()
			? requestedHost.trim()
			: "0.0.0.0";
	const port = Number(requestedPort);
	if (!isValidPort(port)) {
		return {
			http: 400,
			body: {
				...statePayload(),
				error: T(
					"Некорректный порт: укажите число от 1 до 65535.",
					"Not a port: give a number from 1 to 65535.",
				),
			},
		};
	}

	const bindHost = bindHostFor(host);
	const advertiseHost = advertiseHostFor(host);

	// Refuse to spawn if something already holds the port. Check the *bind*
	// address, so a conflict on any interface is caught.
	const free = await checkPortFree(bindHost, port);
	if (!free.ok) {
		state.status = "error";
		state.statusText =
			free.code === "EADDRINUSE"
				? tr(
						`Порт ${port} уже занят на ${bindHost}. Выберите другой порт или остановите занявший его процесс.`,
						`Port ${port} is already taken on ${bindHost}. Choose another port or stop the process that holds it.`,
					)
				: tr(
						`Не удалось занять ${bindHost}:${port} (${free.code ?? "ошибка"}: ${free.message ?? "unknown"}).`,
						`${bindHost}:${port} could not be taken (${free.code ?? "error"}: ${free.message ?? "unknown"}).`,
					);
		pushLog(`[launcher] ${say(state.statusText)}`);
		return {
			http: 409,
			body: { ...statePayload(), error: say(state.statusText) },
		};
	}

	try {
		await writeNodecgConfig(bindHost, port);
	} catch (err) {
		state.status = "error";
		state.statusText = tr(
			`Не удалось записать cfg/nodecg.json: ${err.message}`,
			`cfg/nodecg.json could not be written: ${err.message}`,
		);
		pushLog(`[launcher] ${say(state.statusText)}`);
		return {
			http: 500,
			body: { ...statePayload(), error: say(state.statusText) },
		};
	}

	state.host = host;
	state.bindHost = bindHost;
	state.advertiseHost = advertiseHost;
	state.port = port;
	persistSettings(host, port);

	state.status = "starting";
	state.statusText = tr(
		`Запуск сервера на ${advertiseHost}:${port}…`,
		`Starting the server on ${advertiseHost}:${port}…`,
	);
	pushLog(
		`[launcher] ${T("Запуск", "Starting")}: ${process.execPath} index.js (cwd=${appDir}, ${advertiseHost}:${port})`,
	);
	if (bindHost !== advertiseHost) {
		pushLog(
			T(
				`[launcher] Слушаем ${bindHost} (все интерфейсы), в ссылках — ${advertiseHost}.`,
				`[launcher] Listening on ${bindHost} (all interfaces); the links use ${advertiseHost}.`,
			),
		);
	}

	let child;
	try {
		child = spawn(process.execPath, ["index.js"], {
			cwd: appDir,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				NOTGT_NDI_KEY_FILE: NDI_KEY_FILE,
				NOTGT_FFMPEG_DIR: FFMPEG_DIR,
			},
		});
	} catch (err) {
		state.status = "error";
		state.statusText = tr(
			`Не удалось запустить node index.js: ${err.message}`,
			`node index.js could not be started: ${err.message}`,
		);
		pushLog(`[launcher] ${say(state.statusText)}`);
		return {
			http: 500,
			body: { ...statePayload(), error: say(state.statusText) },
		};
	}

	state.child = child;
	attachLogs(child);

	let spawnError = null;
	child.on("error", (err) => {
		spawnError = err;
	});

	child.on("exit", (code, signal) => {
		if (state.child !== child) return;
		state.child = null;
		void stopSender();
		state.warning = "";
		state.reach = null;
		if (state.status === "stopping") {
			state.status = "stopped";
			state.statusText = tr("Сервер остановлен.", "The server is stopped.");
		} else if (state.status === "running" || state.status === "starting") {
			if (code === 0) {
				state.status = "stopped";
				state.statusText = tr(
					"Сервер завершил работу.",
					"The server has finished.",
				);
			} else {
				state.status = "error";
				state.statusText = tr(
					`Сервер неожиданно завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}).`,
					`The server ended unexpectedly (code ${code}${signal ? `, signal ${signal}` : ""}).`,
				);
			}
		}
		pushLog(
			T(
				`[launcher] Процесс завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}).`,
				`[launcher] The process ended (code ${code}${signal ? `, signal ${signal}` : ""}).`,
			),
		);
	});

	// Poll until the HTTP server answers, the child dies, or we time out.
	const waitStartedAt = Date.now();
	const deadline = waitStartedAt + READY_TIMEOUT_MS;
	let lastNoticeAt = waitStartedAt;
	let loopbackSince = 0; // first time loopback answered, 0 = never
	state.warning = "";
	state.reach = null;
	while (Date.now() < deadline) {
		if (state.child !== child) break; // stopped from under us
		const reach = await measureCurrentReach();
		if (reach.chosenOk) {
			state.reach = reach;
			state.status = "running";
			state.statusText = tr(
				`Сервер работает на ${reach.dialHost}:${port}.`,
				`The server is running on ${reach.dialHost}:${port}.`,
			);
			pushLog(
				`[launcher] ${T("Сервер отвечает", "The server answers")}: ${guiUrlFor(reach.dialHost, port)}`,
			);
			startSender(port);
			break;
		}
		if (reach.loopbackOk) {
			if (!loopbackSince) loopbackSince = Date.now();
			// The server is up; only the advertised address is silent. That is a
			// firewall / routing problem, not a slow start.
			if (
				!reach.loopbackOnly &&
				Date.now() - loopbackSince >= UNREACHABLE_NOTICE_MS
			) {
				state.reach = reach;
				state.status = "running";
				state.warning = joined([
					tr(
						`Сервер работает: 127.0.0.1:${port} отвечает, а ${reach.dialHost}:${port} — нет.`,
						`The server is running: 127.0.0.1:${port} answers, ${reach.dialHost}:${port} does not.`,
					),
					firewallSupported()
						? tr(
								`Обычно это брандмауэр Windows: он не пускает входящие подключения к node.exe. ` +
									`Нажмите «Разрешить порт» в разделе «Сеть и брандмауэр» — лончер создаст правило для всех профилей сети ` +
									`(нужны права администратора). Панель управления при этом уже доступна по 127.0.0.1.`,
								`Usually that is Windows Firewall: it does not let incoming connections reach node.exe. ` +
									`Press “Allow the port” under “Network and firewall” — the launcher makes a rule for every network profile ` +
									`(administrator rights are needed). The dashboard is already reachable on 127.0.0.1.`,
							)
						: tr(
								`Проверьте брандмауэр и маршрутизацию до ${reach.dialHost}.`,
								`Check the firewall and the route to ${reach.dialHost}.`,
							),
				]);
				state.statusText = tr(
					`Сервер работает (127.0.0.1:${port}), но ${reach.dialHost}:${port} недоступен.`,
					`The server is running (127.0.0.1:${port}), but ${reach.dialHost}:${port} cannot be reached.`,
				);
				pushLog(`[launcher] ${say(state.warning)}`);
				startSender(port);
				break;
			}
		} else {
			loopbackSince = 0;
		}
		if (child.exitCode !== null || child.signalCode !== null) break;
		if (spawnError) break;
		if (Date.now() - lastNoticeAt >= READY_NOTICE_MS) {
			lastNoticeAt = Date.now();
			pushLog(
				T(
					`[launcher] Ждём ответа сервера… ${Math.round((Date.now() - waitStartedAt) / 1000)} с ` +
						`(первый запуск на Windows бывает долгим)`,
					`[launcher] Waiting for the server… ${Math.round((Date.now() - waitStartedAt) / 1000)} s ` +
						`(the first start on Windows can take a while)`,
				),
			);
		}
		await delay(READY_POLL_MS);
	}

	if (state.status === "starting") {
		// Timed out (or the process vanished) without becoming ready.
		if (state.child === child) {
			await stopChild(child);
		}
		const tail = state.logs.slice(-12).join("\n");
		state.status = "error";
		state.statusText = spawnError
			? tr(
					`Не удалось запустить сервер: ${spawnError.message}`,
					`The server could not be started: ${spawnError.message}`,
				)
			: await startFailureReport(advertiseHost, port, bindHost, tail);
		pushLog(`[launcher] ${say(state.statusText)}`);
	}

	return { http: 200, body: statePayload() };
}

// ---------------------------------------------------------------------------
// The NDI sender
// ---------------------------------------------------------------------------

/** Whether this tree carries a sender that can run (its Electron installed). */
function senderInstalled() {
	return (
		fs.existsSync(NDI_ENTRY) &&
		fs.existsSync(path.join(ndiDir, "node_modules", "electron", "package.json"))
	);
}

let senderNoticeShown = false;

/**
 * Starts the sender against the server on this machine. It asks the server
 * what to send and idles while no out has NDI switched on; without the NDI
 * runtime it stays up and tells the dashboard so.
 */
function startSender(port) {
	if (!ndiWanted || state.sender) return;
	if (!senderInstalled()) {
		if (!senderNoticeShown) {
			senderNoticeShown = true;
			pushLog(
				T(
					`[launcher] Отправителя NDI нет в ${ndiDir} — выходы NDI не будут отправляться (в репозитории: cd ndi && npm install).`,
					`[launcher] No NDI sender in ${ndiDir} — the NDI outputs will not be sent (in the repository: cd ndi && npm install).`,
				),
			);
		}
		return;
	}
	let sender;
	try {
		// The key file by the environment, not as an argument: Electron on
		// Windows quits at once when a file path is among its arguments.
		sender = spawn(
			process.execPath,
			[NDI_ENTRY, "--server", `http://127.0.0.1:${port}`],
			{
				cwd: ndiDir,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: { ...process.env, NOTGT_TOKEN_FILE: NDI_KEY_FILE },
			},
		);
	} catch (err) {
		pushLog(`[launcher] NDI: ${err.message}`);
		return;
	}
	state.sender = sender;
	attachLogs(sender);
	pushLog(
		T(
			"[launcher] Отправитель NDI запущен.",
			"[launcher] The NDI sender is started.",
		),
	);
	const startedAt = Date.now();
	sender.on("error", (err) => pushLog(`[launcher] NDI: ${err.message}`));
	sender.on("exit", (code, signal) => {
		if (state.sender !== sender) return;
		state.sender = null;
		if (state.status !== "running") return;
		// A sender that ran for a while starts the count again.
		if (Date.now() - startedAt > NDI_RESTART_MAX_MS)
			ndiRestartMs = NDI_RESTART_MS;
		const wait = ndiRestartMs;
		ndiRestartMs = Math.min(ndiRestartMs * 2, NDI_RESTART_MAX_MS);
		pushLog(
			T(
				`[launcher] Отправитель NDI завершился (код ${code}${signal ? `, сигнал ${signal}` : ""}); перезапуск через ${wait / 1000} с.`,
				`[launcher] The NDI sender ended (code ${code}${signal ? `, signal ${signal}` : ""}); restarting in ${wait / 1000} s.`,
			),
		);
		setTimeout(() => {
			if (state.status === "running" && state.port === port) startSender(port);
		}, wait);
	});
}

async function stopSender() {
	const sender = state.sender;
	state.sender = null;
	if (!sender || sender.exitCode !== null || sender.signalCode !== null) return;
	await killTree(sender);
	if (!(await waitExit(sender, KILL_GRACE_MS))) {
		try {
			sender.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}
}

async function stopChild(child) {
	if (!child) return;
	await killTree(child);
	const exited = await waitExit(child, KILL_GRACE_MS);
	if (!exited) {
		// Grace period expired -> force kill (POSIX; on Windows taskkill already forced).
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		await waitExit(child, 2000);
	}
	if (state.child === child) state.child = null;
}

async function stopServer() {
	const child = state.child;
	state.warning = "";
	state.reach = null;
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		state.child = null;
		state.status = "stopped";
		state.statusText = tr("Сервер не запущен.", "The server is not running.");
		return { http: 200, body: statePayload() };
	}

	state.status = "stopping";
	state.statusText = tr("Остановка сервера…", "Stopping the server…");
	await stopSender();
	await stopChild(child);
	state.status = "stopped";
	state.statusText = tr("Сервер остановлен.", "The server is stopped.");
	return { http: 200, body: statePayload() };
}

// ---------------------------------------------------------------------------
// Opening URLs / windows (best effort, never fatal)
// ---------------------------------------------------------------------------

function openUrl(url) {
	try {
		if (process.platform === "win32") {
			// Prefer an Edge "app" window (no browser chrome). `msedge` may not be
			// on PATH, in which case the spawn emits an error and we fall back to
			// the shell `start` command.
			const edge = spawn("msedge", [`--app=${url}`], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			edge.on("error", () => {
				try {
					spawn("cmd", ["/c", "start", "", url], {
						detached: true,
						stdio: "ignore",
						windowsHide: true,
					}).unref();
				} catch {
					/* ignore */
				}
			});
			edge.unref();
			return true;
		}

		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
		child.on("error", () => {
			/* xdg-open etc. may be missing - not fatal */
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// HTTP control server (127.0.0.1 only)
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1_000_000)
			throw new Error(
				T("Тело запроса слишком большое.", "The request body is too large."),
			);
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

async function handleRequest(req, res) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const { pathname } = url;
	const method = req.method ?? "GET";

	if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
		let html;
		try {
			html = await fsp.readFile(path.join(__dirname, "ui.html"), "utf8");
		} catch (err) {
			sendJson(res, 500, {
				error: T(
					`Не удалось прочитать ui.html: ${err.message}`,
					`ui.html could not be read: ${err.message}`,
				),
			});
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(html);
		return;
	}

	if (method === "GET" && pathname === "/api/state") {
		lastSeenAt = Date.now();
		sendJson(res, 200, statePayload());
		return;
	}

	// The window is closing. A server that is running stays up, and this
	// process with it, unless the window asks for it to be stopped; with no
	// server to look after there is nothing to stay for.
	if (method === "POST" && pathname === "/api/quit") {
		if (!isJsonRequest(req)) {
			sendJson(res, 415, {
				ok: false,
				message: T(
					"Нужен запрос в формате JSON.",
					"The request has to be JSON.",
				),
			});
			return;
		}
		const body = await readJsonBody(req);
		const running = Boolean(state.child);
		const stays = running && body.stop !== true;
		sendJson(res, 200, { ok: true, running, stays });
		if (!stays) setTimeout(() => void gracefulShutdown(0), 50);
		return;
	}

	if (method === "GET" && pathname === "/api/logs") {
		let since = Number(url.searchParams.get("since") ?? "0");
		if (!Number.isFinite(since) || since < 0) since = 0;
		const start = bufferStart();
		if (since < start) since = start;
		sendJson(res, 200, {
			lines: state.logs.slice(since - start),
			next: state.logCount,
		});
		return;
	}

	if (method === "POST" && pathname === "/api/start") {
		const body = await readJsonBody(req);
		const result = await startServer(body.host, body.port);
		sendJson(res, result.http, result.body);
		return;
	}

	if (method === "POST" && pathname === "/api/stop") {
		const result = await stopServer();
		sendJson(res, result.http, result.body);
		return;
	}

	if (method === "POST" && pathname === "/api/open") {
		const body = await readJsonBody(req);
		const target =
			typeof body.url === "string" && body.url ? body.url : effectiveGuiUrl();
		const ok = openUrl(target);
		sendJson(res, 200, { ok, url: target });
		return;
	}

	if (method === "POST" && pathname === "/api/reach") {
		state.reach = await measureCurrentReach();
		if (state.reach.chosenOk) state.warning = "";
		sendJson(res, 200, { reach: state.reach, warning: say(state.warning) });
		return;
	}

	if (method === "GET" && pathname === "/api/diagnostics") {
		const result = await diagnose();
		state.reach = result.reach;
		if (result.reach.chosenOk) state.warning = "";
		sendJson(res, 200, {
			...result,
			host: state.host,
			advertiseHost: currentAdvertiseHost(),
			port: state.port,
			running: Boolean(state.child),
			platform: process.platform,
			loopbackUrl: `http://127.0.0.1:${state.port}/dashboard/`,
			networkUrl: guiUrlFor(currentAdvertiseHost(), state.port),
		});
		return;
	}

	if (method === "POST" && pathname === "/api/firewall/allow") {
		const body = await readJsonBody(req);
		const port = isValidPort(Number(body.port))
			? Number(body.port)
			: state.port;
		const result = addFirewallRule(port);
		// The rule only matters if packets now get through: re-probe and report.
		state.reach = await measureCurrentReach();
		if (result.ok && state.reach.chosenOk) state.warning = "";
		sendJson(res, 200, {
			...result,
			firewall: firewallInfo(port),
			reach: state.reach,
			warning: say(state.warning),
		});
		return;
	}

	// One press in the window: download ffmpeg and unpack it next to the
	// launcher. It runs in the background; GET /api/state shows how far it is.
	if (method === "POST" && pathname === "/api/ffmpeg/install") {
		if (!isJsonRequest(req)) {
			sendJson(res, 415, {
				ok: false,
				message: T(
					"Нужен запрос в формате JSON.",
					"The request has to be JSON.",
				),
			});
			return;
		}
		const info = ffmpegInfo();
		if (ffmpegState.installing) {
			sendJson(res, 409, { ok: false, message: info.text, ffmpeg: info });
			return;
		}
		if (info.installed) {
			sendJson(res, 200, { ok: true, message: info.text, ffmpeg: info });
			return;
		}
		if (!info.canInstall) {
			sendJson(res, 400, {
				ok: false,
				message: T(
					"Здесь ffmpeg ставится средствами системы (brew install ffmpeg, apt install ffmpeg).",
					"Here ffmpeg is installed with the system's tools (brew install ffmpeg, apt install ffmpeg).",
				),
				ffmpeg: info,
			});
			return;
		}
		(IS_ELEVATED ? installFfmpeg() : installFfmpegElevated()).catch((err) =>
			pushLog(`[launcher] ffmpeg: ${String(err?.stack ?? err)}`),
		);
		const started = ffmpegInfo();
		sendJson(res, 202, { ok: true, message: started.text, ffmpeg: started });
		return;
	}

	if (method === "POST" && pathname === "/api/firewall/remove") {
		const body = await readJsonBody(req);
		const port = isValidPort(Number(body.port))
			? Number(body.port)
			: state.port;
		const result = removeFirewallRule(port);
		sendJson(res, 200, { ...result, firewall: firewallInfo(port) });
		return;
	}

	if (method === "POST" && pathname === "/api/login") {
		if (!isJsonRequest(req)) {
			sendJson(res, 415, {
				ok: false,
				message: T(
					"Нужен запрос в формате JSON.",
					"The request has to be JSON.",
				),
			});
			return;
		}
		const body = await readJsonBody(req);
		const username =
			typeof body.username === "string" ? body.username.trim() : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!username || !password) {
			sendJson(res, 400, {
				ok: false,
				message: T("Укажите имя и пароль.", "Give a name and a password."),
			});
			return;
		}
		try {
			await enableLogin(username, password);
		} catch (err) {
			sendJson(res, 500, {
				ok: false,
				message: T(
					`Не удалось записать cfg/nodecg.json: ${err.message}`,
					`cfg/nodecg.json could not be written: ${err.message}`,
				),
			});
			return;
		}
		sendJson(
			res,
			200,
			loginResult(
				T(
					`Вход включён: панель будет спрашивать пароль у «${username}».`,
					`The sign-in is on: the dashboard will ask “${username}” for the password.`,
				),
			),
		);
		return;
	}

	if (method === "POST" && pathname === "/api/lang") {
		const body = await readJsonBody(req);
		if (!isLang(body.lang)) {
			sendJson(res, 400, { ok: false, message: `lang: ${LANGS.join(" | ")}` });
			return;
		}
		lang = body.lang;
		persistSettings(state.host, state.port);
		sendJson(res, 200, statePayload());
		return;
	}

	if (method === "POST" && pathname === "/api/login/default") {
		if (!isJsonRequest(req)) {
			sendJson(res, 415, {
				ok: false,
				message: T(
					"Нужен запрос в формате JSON.",
					"The request has to be JSON.",
				),
			});
			return;
		}
		try {
			await resetLogin();
		} catch (err) {
			sendJson(res, 500, {
				ok: false,
				message: T(
					`Не удалось записать cfg/nodecg.json: ${err.message}`,
					`cfg/nodecg.json could not be written: ${err.message}`,
				),
			});
			return;
		}
		sendJson(
			res,
			200,
			loginResult(
				T(
					"Вход включён: пользователи задаются в панели, во вкладке «Команда».",
					"The sign-in is on: the users are kept in the dashboard, in the Team tab.",
				),
			),
		);
		return;
	}

	if (method === "POST" && pathname === "/api/login/disable") {
		if (!isJsonRequest(req)) {
			sendJson(res, 415, {
				ok: false,
				message: T(
					"Нужен запрос в формате JSON.",
					"The request has to be JSON.",
				),
			});
			return;
		}
		try {
			await disableLogin();
		} catch (err) {
			sendJson(res, 500, {
				ok: false,
				message: T(
					`Не удалось записать cfg/nodecg.json: ${err.message}`,
					`cfg/nodecg.json could not be written: ${err.message}`,
				),
			});
			return;
		}
		sendJson(
			res,
			200,
			loginResult(
				T(
					"Вход отключён: панель открыта без пароля.",
					"The sign-in is off: the dashboard opens without a password.",
				),
			),
		);
		return;
	}

	sendJson(res, 404, { error: "Not found" });
}

const controlServer = http.createServer((req, res) => {
	handleRequest(req, res).catch((err) => {
		try {
			sendJson(res, 500, { error: err?.message ?? String(err) });
		} catch {
			/* response may already be sent */
		}
	});
});

controlServer.on("error", (err) => {
	process.stderr.write(`[launcher] control server error: ${err.message}\n`);
	process.exit(1);
});

// ---------------------------------------------------------------------------
// Shutdown handling - always take the child down with us
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function gracefulShutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		await stopServer();
	} catch {
		/* ignore */
	}
	try {
		controlServer.close();
	} catch {
		/* ignore */
	}
	process.exit(code);
}

// The window starts this process with its stderr going nowhere, so a crash
// left no trace but "the service process has ended". A promise that fails
// unhandled is logged instead of ending the process, and what does end it is
// written to launcher-crash.log next to the settings.
const CRASH_LOG = path.join(path.dirname(PERSIST_PATH), "launcher-crash.log");
process.on("unhandledRejection", (err) => {
	pushLog(`[launcher] ${String(err?.stack ?? err)}`);
});
process.on("uncaughtException", (err) => {
	try {
		fs.appendFileSync(
			CRASH_LOG,
			`${new Date().toISOString()} launcher ${VERSION}\n${String(err?.stack ?? err)}\n\n`,
		);
	} catch {
		/* nowhere to write it */
	}
	process.exit(1);
});
process.on("SIGINT", () => void gracefulShutdown(0));
process.on("SIGTERM", () => void gracefulShutdown(0));
process.on("exit", () => {
	hardKillChild();
	try {
		// Only our own note: a newer launcher may have written its own since.
		const note = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
		if (note.pid === process.pid) fs.rmSync(RUNTIME_PATH, { force: true });
	} catch {
		/* no note, or not ours to remove */
	}
});
// Whoever read our banner may be gone by the time something else is printed.
process.stdout.on("error", () => {});

// ---------------------------------------------------------------------------
// Living in the background (`--background`, what the window starts us with)
// ---------------------------------------------------------------------------
//
// The window can be closed while the server runs; this process then stays to
// look after the server, and the next window finds it through RUNTIME_PATH.
// Without a server and without a window asking for the state there is nobody
// left to serve — the window crashed, or was closed with the server stopped —
// and the process ends by itself.

const IDLE_EXIT_MS = 20_000;
let lastSeenAt = Date.now();

if (args.background) {
	setInterval(() => {
		const busy =
			state.child ||
			state.status === "starting" ||
			state.status === "stopping" ||
			ffmpegState.installing;
		if (!busy && Date.now() - lastSeenAt > IDLE_EXIT_MS) {
			void gracefulShutdown(0);
		}
	}, 5_000).unref();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Started through UAC to install ffmpeg: that is all this process does.
if (args.installFfmpeg) {
	process.exit(await runFfmpegWorker(path.resolve(args.installFfmpeg)));
}

const listenPort =
	isValidPort(args.controlPort) || args.controlPort === 0
		? args.controlPort
		: 0;

controlServer.listen(listenPort, "127.0.0.1", () => {
	const actualPort = controlServer.address().port;
	const controlUrl = `http://127.0.0.1:${actualPort}`;

	try {
		fs.writeFileSync(
			RUNTIME_PATH,
			JSON.stringify({ pid: process.pid, port: actualPort }) + "\n",
			"utf8",
		);
	} catch {
		/* best effort: without the note a new window starts a launcher of its own */
	}

	// The one and only stdout line. Everything else (child output) stays in the buffer.
	process.stdout.write(`notGT launcher on ${controlUrl}\n`);

	if (args.open) {
		openUrl(`${controlUrl}/`);
	}
});
