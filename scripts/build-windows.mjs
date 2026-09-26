#!/usr/bin/env node
/**
 * scripts/build-windows.mjs — portable Windows package builder for notGT.
 *
 * Produces `notGT-win-x64/` and (unless --no-zip) `notGT-win-x64.zip`:
 *
 *   notGT-win-x64/
 *     notGT Launcher.exe      native bootstrap (mingw, when available)
 *     notGT.cmd               fallback bootstrap (always works)
 *     launcher/index.mjs      control UI + server supervisor
 *     launcher/ui.html
 *     node/node.exe ...       official Windows Node runtime
 *     app/                    NodeCG runtime root
 *       index.js, package.json, node_modules/, workspaces/<pkg>/dist
 *       bundles/notGT/        built bundle (no node_modules)
 *       cfg/ db/ assets/ logs/
 *     README.txt
 *
 * Runs on Linux (layout/UI verification) and on windows-latest (release
 * builds). Only Node builtins plus the tools listed in the task are used:
 * npm, tar/unzip, zip, curl-free (fetch), and optionally mingw-w64.
 *
 * IMPORTANT: this never touches the developer's root `node_modules`. The
 * production dependency tree is installed with `npm ci --omit=dev` into a
 * throwaway staging copy of the manifests in the OS temp directory.
 *
 * Usage:
 *   node scripts/build-windows.mjs [--node-version 22.14.0] [--out dist]
 *                                  [--skip-build] [--no-zip]
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants / CLI
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IS_WINDOWS = process.platform === "win32";

const PACKAGE_DIR_NAME = "notGT-win-x64";
const LAUNCHER_EXE_NAME = "notGT Launcher.exe";
const BUNDLE_DIR = path.join(REPO_ROOT, "bundles", "notGT");
const LAUNCHER_DIR = path.join(REPO_ROOT, "launcher");
const LAUNCHER_C_SRC = path.join(LAUNCHER_DIR, "win", "notGT-launcher.c");
const NODE_DIST_BASE = "https://nodejs.org/dist";

function parseArgs(argv) {
	const opts = {
		nodeVersion: "22.14.0",
		out: "dist",
		skipBuild: false,
		zip: true,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? null : arg.slice(eq + 1);
		const take = () => (inline !== null ? inline : argv[++i]);
		switch (key) {
			case "--node-version":
				opts.nodeVersion = take();
				break;
			case "--out":
				opts.out = take();
				break;
			case "--skip-build":
				opts.skipBuild = true;
				break;
			case "--no-zip":
				opts.zip = false;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg} (try --help)`);
		}
	}
	if (opts.nodeVersion && !/^\d+\.\d+\.\d+$/.test(opts.nodeVersion)) {
		throw new Error(`--node-version must look like x.y.z (got ${opts.nodeVersion})`);
	}
	return opts;
}

let opts;
try {
	opts = parseArgs(process.argv.slice(2));
} catch (err) {
	console.error(`[build-windows] FAILED: ${err.message}`);
	process.exit(1);
}

const OUT_ROOT = path.isAbsolute(opts.out)
	? opts.out
	: path.resolve(REPO_ROOT, opts.out);
const PACKAGE_DIR = path.join(OUT_ROOT, PACKAGE_DIR_NAME);
const CACHE_DIR = path.join(OUT_ROOT, ".cache");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...args) => console.log("[build-windows]", ...args);
const warn = (...args) => console.warn("[build-windows] WARNING:", ...args);

/** Quote one argument for cmd.exe (only used on Windows, with shell: true). */
function winQuote(value) {
	const s = String(value);
	if (s === "") return '""';
	if (!/[\s"]/.test(s)) return s;
	return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Run a command and fail loudly unless `optional` is set.
 * On Windows commands are invoked through cmd.exe so `npm` (npm.cmd) and
 * paths containing spaces work; on POSIX arguments are passed verbatim.
 */
function run(command, args, { cwd = REPO_ROOT, env = {}, optional = false, label } = {}) {
	log(`$ ${[command, ...args].join(" ")}${cwd === REPO_ROOT ? "" : `   (cwd: ${cwd})`}`);
	const result = IS_WINDOWS
		? spawnSync([command, ...args].map(winQuote).join(" "), {
				cwd,
				stdio: "inherit",
				env: { ...process.env, ...env },
				shell: true,
			})
		: spawnSync(command, args, {
				cwd,
				stdio: "inherit",
				env: { ...process.env, ...env },
			});
	if (result.error) {
		if (optional) {
			warn(`${label ?? command} is unavailable: ${result.error.message}`);
			return false;
		}
		throw new Error(`Could not run "${command}": ${result.error.message}`);
	}
	if (result.status !== 0) {
		if (optional) {
			warn(`${label ?? command} exited with code ${result.status}`);
			return false;
		}
		throw new Error(`Command failed with code ${result.status}: ${command} ${args.join(" ")}`);
	}
	return true;
}

function commandExists(command) {
	const probe = IS_WINDOWS
		? spawnSync(winQuote(command) + " --version", { stdio: "ignore", shell: true })
		: spawnSync(command, ["--version"], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

function human(bytes) {
	const units = ["B", "KiB", "MiB", "GiB"];
	let n = bytes;
	let u = 0;
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024;
		u++;
	}
	return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
}

function dirSize(dir) {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			let stat;
			try {
				stat = fs.statSync(full); // follows symlinks, which never exist here
			} catch {
				continue;
			}
			if (stat.isDirectory()) stack.push(full);
			else total += stat.size;
		}
	}
	return total;
}

function exists(p) {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/**
 * Recursive copy that FOLLOWS symlinks and copies real files/directories.
 *
 * `fs.cpSync(..., { dereference: true })` is not reliable here (it can emit
 * absolute symlinks instead of dereferencing them), and a package full of
 * symlinks pointing into a deleted staging dir — or requiring symlink
 * privileges to unzip on Windows — is useless. So walk the tree manually and
 * copy through the links, skipping symlink cycles.
 *
 * `skipNames` drops entries by basename (e.g. `node_modules`).
 */
function copyTree(src, dest, { skipNames = [] } = {}) {
	if (!exists(src)) throw new Error(`Cannot copy missing path: ${src}`);
	const active = new Set(); // realpaths on the current descent, for cycles

	const walk = (from, to) => {
		let stat;
		try {
			stat = fs.statSync(from); // follows symlinks
		} catch (err) {
			warn(`Skipping unreadable entry ${from}: ${err.code ?? err.message}`);
			return;
		}
		if (stat.isDirectory()) {
			const real = fs.realpathSync(from);
			if (active.has(real)) {
				warn(`Skipping symlink cycle at ${from}`);
				return;
			}
			active.add(real);
			fs.mkdirSync(to, { recursive: true });
			for (const entry of fs.readdirSync(from)) {
				if (skipNames.includes(entry)) continue;
				walk(path.join(from, entry), path.join(to, entry));
			}
			active.delete(real);
			return;
		}
		if (stat.isFile()) {
			fs.copyFileSync(from, to);
			try {
				fs.chmodSync(to, stat.mode & 0o777);
			} catch {
				/* best effort; irrelevant for the Windows zip */
			}
		}
	};

	walk(src, dest);
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function fetchText(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
	return res.text();
}

async function downloadFile(url, dest) {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} while downloading ${url}`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// ---------------------------------------------------------------------------
// 1. Builds (root + bundle)
// ---------------------------------------------------------------------------

/**
 * `npm ci` needs a writable cache. Respect an explicit npm_config_cache (CI's
 * setup-node sets one); otherwise, if the user's default `~/.npm` is not
 * writable (sandboxes, read-only homes), fall back to a cache inside the
 * output root instead of failing with EROFS.
 */
function ensureNpmCacheWritable() {
	if (process.env.npm_config_cache) return;
	const defaultCache = path.join(os.homedir(), ".npm");
	try {
		fs.mkdirSync(defaultCache, { recursive: true });
		fs.accessSync(defaultCache, fs.constants.W_OK);
		return;
	} catch {
		const cache = path.join(CACHE_DIR, "npm");
		const tmp = path.join(CACHE_DIR, "npm-tmp");
		fs.mkdirSync(cache, { recursive: true });
		fs.mkdirSync(tmp, { recursive: true });
		process.env.npm_config_cache = cache;
		process.env.npm_config_tmp = tmp;
		warn(
			`Default npm cache (${defaultCache}) is not writable; using ${cache} instead.`,
		);
	}
}

function runBuilds() {
	log("Building NodeCG workspaces (root npm run build)…");
	run("npm", ["run", "build"], { cwd: REPO_ROOT });

	log("Installing + building the notGT bundle…");
	run("npm", ["ci"], {
		cwd: BUNDLE_DIR,
		env: {
			PUPPETEER_SKIP_DOWNLOAD: "true",
			PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true",
		},
	});
	run("npm", ["run", "build"], { cwd: BUNDLE_DIR });
}

function assertBuildOutputs() {
	const required = [
		path.join(REPO_ROOT, "index.js"),
		path.join(REPO_ROOT, "package.json"),
		path.join(BUNDLE_DIR, "extension", "index.js"),
		path.join(BUNDLE_DIR, "dashboard", "assets"),
		path.join(BUNDLE_DIR, "graphics", "assets"),
	];
	const missing = required.filter((p) => !exists(p));
	for (const ws of listWorkspaces()) {
		if (!exists(path.join(ws, "dist"))) missing.push(path.join(ws, "dist"));
	}
	if (missing.length > 0) {
		throw new Error(
			`Build output is incomplete:\n  ${missing.join("\n  ")}\n` +
				`Run without --skip-build (root "npm run build" + bundle "npm ci && npm run build").`,
		);
	}
}

function listWorkspaces() {
	return fs
		.readdirSync(path.join(REPO_ROOT, "workspaces"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(REPO_ROOT, "workspaces", entry.name));
}

// ---------------------------------------------------------------------------
// 2. Production dependencies, in a throwaway staging directory
// ---------------------------------------------------------------------------

/**
 * Copy the manifests + built workspaces into a temp dir and run
 * `npm ci --omit=dev` there. The developer's root node_modules is never
 * touched (it is needed by the running dev server).
 */
function stageProductionNodeModules() {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-win-stage-"));
	log(`Staging production dependencies in ${stage} (root node_modules untouched)…`);
	fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(stage, "package.json"));
	fs.copyFileSync(
		path.join(REPO_ROOT, "package-lock.json"),
		path.join(stage, "package-lock.json"),
	);
	fs.mkdirSync(path.join(stage, "workspaces"), { recursive: true });
	for (const ws of listWorkspaces()) {
		copyTree(ws, path.join(stage, "workspaces", path.basename(ws)), {
			skipNames: ["node_modules"],
		});
	}
	run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
		cwd: stage,
		env: {
			PUPPETEER_SKIP_DOWNLOAD: "true",
			PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true",
		},
	});
	const stagedModules = path.join(stage, "node_modules");
	if (!exists(path.join(stagedModules, "nodecg"))) {
		throw new Error("Staging install did not produce node_modules/nodecg");
	}
	return { stage, stagedModules };
}

// ---------------------------------------------------------------------------
// 3. Assemble app/
// ---------------------------------------------------------------------------

function assembleApp(stagedModules) {
	const app = path.join(PACKAGE_DIR, "app");
	fs.mkdirSync(app, { recursive: true });

	// Runtime entry point + root manifest (needed: nodecgRoot: true).
	fs.copyFileSync(path.join(REPO_ROOT, "index.js"), path.join(app, "index.js"));
	fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(app, "package.json"));

	// Built workspaces (dist/, types/, schemas/, …) — no nested node_modules.
	fs.mkdirSync(path.join(app, "workspaces"), { recursive: true });
	for (const ws of listWorkspaces()) {
		copyTree(ws, path.join(app, "workspaces", path.basename(ws)), {
			skipNames: ["node_modules"],
		});
	}

	// Built notGT bundle — no node_modules, no e2e artifacts.
	fs.mkdirSync(path.join(app, "bundles"), { recursive: true });
	copyTree(path.join(BUNDLE_DIR), path.join(app, "bundles", "notGT"), {
		skipNames: ["node_modules", ".e2e"],
	});
	// Never ship a real bundle config (apiToken lives there).
	fs.rmSync(path.join(app, "bundles", "notGT", "cfg", "notGT.json"), { force: true });

	// Production-only dependency tree, symlinks dereferenced so the zip is
	// portable to Windows without needing symlink support.
	copyTree(stagedModules, path.join(app, "node_modules"));

	// Fresh state directories. Deliberately NOT copied from the repo: cfg may
	// hold secrets, db/ and assets/ hold the developer's data.
	for (const dir of ["cfg", "db", "assets", "logs"]) {
		fs.mkdirSync(path.join(app, dir), { recursive: true });
	}
	fs.writeFileSync(path.join(app, "cfg", "README.txt"), cfgReadmeText(), "utf8");
}

// ---------------------------------------------------------------------------
// 4. Official Windows Node runtime
// ---------------------------------------------------------------------------

async function expectedNodeSha(version, zipName) {
	const sums = await fetchText(`${NODE_DIST_BASE}/v${version}/SHASUMS256.txt`);
	for (const line of sums.split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
		if (match && match[2] === zipName) return match[1].toLowerCase();
	}
	throw new Error(`No SHA-256 entry for ${zipName} in SHASUMS256.txt`);
}

async function ensureNodeRuntime(destDir, version) {
	const zipName = `node-v${version}-win-x64.zip`;
	const zipPath = path.join(CACHE_DIR, zipName);
	const url = `${NODE_DIST_BASE}/v${version}/${zipName}`;
	fs.mkdirSync(CACHE_DIR, { recursive: true });

	log(`Verifying ${zipName} against SHASUMS256.txt…`);
	const expected = await expectedNodeSha(version, zipName);

	let cached = false;
	if (exists(zipPath)) {
		const actual = await sha256File(zipPath);
		if (actual === expected) {
			log(`Using cached ${zipName} (SHA-256 OK)`);
			cached = true;
		} else {
			warn(`Cached ${zipName} has a bad SHA-256 (${actual}); re-downloading`);
		}
	}
	if (!cached) {
		const partPath = `${zipPath}.part`;
		fs.rmSync(partPath, { force: true });
		log(`Downloading ${url}…`);
		await downloadFile(url, partPath);
		const actual = await sha256File(partPath);
		if (actual !== expected) {
			fs.rmSync(partPath, { force: true });
			throw new Error(
				`SHA-256 mismatch for ${zipName}: expected ${expected}, got ${actual}`,
			);
		}
		fs.renameSync(partPath, zipPath);
		log(`SHA-256 OK: ${expected}`);
	}

	const extractDir = path.join(CACHE_DIR, `extract-node-v${version}-win-x64`);
	const marker = path.join(extractDir, ".notgt-extracted");
	if (!exists(marker)) {
		fs.rmSync(extractDir, { recursive: true, force: true });
		fs.mkdirSync(extractDir, { recursive: true });
		log(`Extracting ${zipName}…`);
		if (IS_WINDOWS) {
			// bsdtar ships with Windows and understands zip; GNU tar cannot.
			run("tar", ["-xf", zipPath, "-C", extractDir]);
		} else {
			run("unzip", ["-q", "-o", zipPath, "-d", extractDir]);
		}
		fs.writeFileSync(marker, `${version}\n`, "utf8");
	} else {
		log(`Using cached extracted runtime for ${version}`);
	}

	const inner = path.join(extractDir, `node-v${version}-win-x64`);
	if (!exists(path.join(inner, "node.exe"))) {
		throw new Error(`node.exe missing after extracting ${zipName} (${inner})`);
	}
	fs.rmSync(destDir, { recursive: true, force: true });
	copyTree(inner, destDir);
	log(`Node runtime placed in ${path.relative(REPO_ROOT, destDir)}`);
}

// ---------------------------------------------------------------------------
// 5. Native launcher + .cmd fallback
// ---------------------------------------------------------------------------

function buildLauncherExe() {
	if (!exists(LAUNCHER_C_SRC)) {
		warn(`${path.relative(REPO_ROOT, LAUNCHER_C_SRC)} not found — skipping the .exe`);
		return false;
	}
	const candidates = [];
	if (process.env.MINGW_GCC) candidates.push(process.env.MINGW_GCC);
	candidates.push("x86_64-w64-mingw32-gcc");
	if (IS_WINDOWS) candidates.push("gcc"); // MSYS2/Strawberry mingw if present

	const outExe = path.join(PACKAGE_DIR, LAUNCHER_EXE_NAME);
	for (const cc of candidates) {
		if (!commandExists(cc)) continue;
		log(`Compiling ${LAUNCHER_EXE_NAME} with ${cc}…`);
		const ok = run(
			cc,
			["-O2", "-municode", "-mwindows", "-o", outExe, LAUNCHER_C_SRC],
			{ optional: true, label: cc },
		);
		if (ok && exists(outExe)) return true;
		fs.rmSync(outExe, { force: true });
	}
	warn(
		`mingw-w64 not found: "${LAUNCHER_EXE_NAME}" was NOT built. ` +
			`The package still works via notGT.cmd (it opens a console window).`,
	);
	return false;
}

function writeCmdFallback() {
	const cmd = [
		"@echo off",
		"rem notGT launcher (fallback for builds without mingw-w64).",
		"rem Keep this file next to the node\\ and launcher\\ folders.",
		"rem This file is UTF-8; switch the console so the Russian messages render.",
		"chcp 65001 >nul 2>nul",
		"setlocal",
		'pushd "%~dp0" || exit /b 1',
		'if not exist "node\\node.exe" (',
		"  echo Не найден node\\node.exe — распакуйте ZIP-архив целиком.",
		"  pause",
		"  exit /b 1",
		")",
		'if not exist "launcher\\index.mjs" (',
		"  echo Не найден launcher\\index.mjs — распакуйте ZIP-архив целиком.",
		"  pause",
		"  exit /b 1",
		")",
		'"node\\node.exe" "launcher\\index.mjs" --app "app" %*',
		"set NOTGT_EXIT=%ERRORLEVEL%",
		"popd",
		"if not \"%NOTGT_EXIT%\"==\"0\" (",
		"  echo.",
		"  echo notGT launcher завершился с кодом %NOTGT_EXIT%.",
		"  pause",
		")",
		"exit /b %NOTGT_EXIT%",
		"",
	].join("\r\n");
	fs.writeFileSync(path.join(PACKAGE_DIR, "notGT.cmd"), cmd, "utf8");
}

// ---------------------------------------------------------------------------
// 6. README.txt / cfg/README.txt (Russian)
// ---------------------------------------------------------------------------

function readmeText() {
	return [
		"notGT — портативная сборка для Windows",
		"=======================================",
		"",
		"Что это",
		"-------",
		"notGT — система веб-титров и broadcast-анимации на базе NodeCG.",
		"В этой папке уже есть всё необходимое: собственный Node.js, сервер NodeCG",
		"и приложение notGT. Ставить Node.js или что-то ещё не нужно.",
		"",
		"Как запустить",
		"-------------",
		"1. Распакуйте ZIP-архив ЦЕЛИКОМ в отдельную папку (не запускайте",
		"   программу прямо из окна архиватора).",
		"2. Дважды щёлкните «notGT Launcher.exe».",
		"   Если файла .exe нет (сборка без mingw-w64) — запустите notGT.cmd.",
		"3. Откроется страница управления лаунчера. Выберите сетевой интерфейс",
		"   и порт и нажмите «Запустить».",
		"",
		"Лаунчер сам подбирает свободный порт, записывает выбранные host/port в",
		"app\\cfg\\nodecg.json, запускает сервер NodeCG и открывает дашборд.",
		"Пока лаунчер запущен, сервер живёт вместе с ним; закрытие лаунчера",
		"останавливает сервер.",
		"",
		"Дашборд: http://<выбранный-интерфейс>:<порт>/dashboard/",
		"",
		"OBS Studio",
		"----------",
		"Добавьте Browser Source с адресом:",
		"",
		"  http://<выбранный-интерфейс>:<порт>/bundles/notGT/graphics/out.html?out=main",
		"",
		"Размер: 1920x1080. Включите «Прозрачный фон» (Custom CSS не нужен).",
		"Если сервер слушает 0.0.0.0, локально можно писать 127.0.0.1, а для",
		"других машин — IP этого компьютера.",
		"",
		"Другие выходы (outs) открываются так же, с другим ?out=<id>: например",
		"  http://<выбранный-интерфейс>:<порт>/bundles/notGT/graphics/out.html?out=interview",
		"",
		"Где что лежит",
		"-------------",
		"app\\cfg\\      — конфигурация. nodecg.json (host/port) и notGT.json",
		"                 создаются/обновляются при запуске. Здесь же можно",
		"                 задать apiToken для REST API.",
		"app\\db\\       — база данных NodeCG (SQLite).",
		"app\\assets\\   — загруженные медиафайлы (картинки, видео, шрифты).",
		"                 Сохраняются между обновлениями программы.",
		"app\\logs\\     — журналы работы сервера.",
		"launcher\\      — код лаунчера и его веб-интерфейс.",
		"node\\          — официальный Node.js для Windows (менять не нужно).",
		"",
		"Обновление",
		"----------",
		"Распакуйте новую версию в НОВУЮ папку, затем перенесите в неё",
		"app\\cfg, app\\db и app\\assets из старой папки — так сохранятся настройки,",
		"база и загруженные медиа.",
		"",
		"Перенос на другой компьютер: скопируйте всю папку целиком. Пути",
		"относительные, ничего доустанавливать не требуется.",
		"",
	].join("\r\n");
}

function cfgReadmeText() {
	return [
		"Этот каталог принадлежит приложению NodeCG.",
		"",
		"nodecg.json создаётся и обновляется лаунчером notGT при запуске сервера",
		"(в нём хранятся выбранные host и port). Конфигурация бандла notGT лежит",
		"рядом в notGT.json и создаётся из",
		"app\\bundles\\notGT\\cfg\\notGT.example.json.",
		"",
		"Не публикуйте содержимое этого каталога: в нём могут быть токены.",
		"",
	].join("\r\n");
}

// ---------------------------------------------------------------------------
// 7. Zip + summary
// ---------------------------------------------------------------------------

function makeZip() {
	const zipPath = path.join(OUT_ROOT, `${PACKAGE_DIR_NAME}.zip`);
	fs.rmSync(zipPath, { force: true });
	if (IS_WINDOWS && !commandExists("zip")) {
		// Windows 10+ ships bsdtar, which can write zip via -a.
		log(`Creating ${path.relative(REPO_ROOT, zipPath)} with tar (bsdtar)…`);
		run("tar", ["-a", "-c", "-f", `${PACKAGE_DIR_NAME}.zip`, PACKAGE_DIR_NAME], {
			cwd: OUT_ROOT,
		});
	} else {
		log(`Creating ${path.relative(REPO_ROOT, zipPath)}…`);
		run("zip", ["-r", "-q", `${PACKAGE_DIR_NAME}.zip`, PACKAGE_DIR_NAME], {
			cwd: OUT_ROOT,
		});
	}
	if (!exists(zipPath)) throw new Error(`zip was not created: ${zipPath}`);
	return zipPath;
}

function printSummary(zipPath, exeBuilt) {
	const checks = [
		["notGT Launcher.exe", path.join(PACKAGE_DIR, LAUNCHER_EXE_NAME)],
		["notGT.cmd", path.join(PACKAGE_DIR, "notGT.cmd")],
		["launcher/index.mjs", path.join(PACKAGE_DIR, "launcher", "index.mjs")],
		["launcher/ui.html", path.join(PACKAGE_DIR, "launcher", "ui.html")],
		["node/node.exe", path.join(PACKAGE_DIR, "node", "node.exe")],
		["app/index.js", path.join(PACKAGE_DIR, "app", "index.js")],
		["app/bundles/notGT/extension/index.js", path.join(PACKAGE_DIR, "app", "bundles", "notGT", "extension", "index.js")],
		["app/workspaces/nodecg/dist", path.join(PACKAGE_DIR, "app", "workspaces", "nodecg", "dist")],
	];
	console.log("");
	log(`Package: ${PACKAGE_DIR}`);
	for (const [label, p] of checks) {
		const mark = exists(p) ? "ok     " : "MISSING";
		console.log(`  [${mark}] ${label}`);
	}
	console.log("");
	log("Top-level contents:");
	for (const entry of fs.readdirSync(PACKAGE_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(PACKAGE_DIR, entry.name);
		const size = entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
		console.log(`  ${entry.isDirectory() ? "d" : "f"} ${entry.name.padEnd(24)} ${human(size)}`);
	}
	log(`Total package size: ${human(dirSize(PACKAGE_DIR))}`);
	if (zipPath) log(`Zip: ${zipPath} (${human(fs.statSync(zipPath).size)})`);
	if (!exeBuilt) {
		warn(`No "${LAUNCHER_EXE_NAME}": ship notGT.cmd as the entry point (or rebuild with mingw-w64).`);
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	if (opts.help) {
		console.log(
			"Usage: node scripts/build-windows.mjs [--node-version 22.14.0] [--out dist]\n" +
				"                                       [--skip-build] [--no-zip]",
		);
		return;
	}

	log(`notGT Windows package builder (Node ${process.version}, ${process.platform})`);
	log(`Node runtime version: ${opts.nodeVersion}`);
	log(`Output root: ${OUT_ROOT}`);

	ensureNpmCacheWritable();

	if (!opts.skipBuild) runBuilds();
	else log("--skip-build: reusing existing build output");
	assertBuildOutputs();

	// Start clean so re-runs cannot leave stale files behind.
	fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
	fs.mkdirSync(PACKAGE_DIR, { recursive: true });

	const { stage, stagedModules } = stageProductionNodeModules();
	try {
		log("Assembling app/…");
		assembleApp(stagedModules);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}

	fs.mkdirSync(path.join(PACKAGE_DIR, "launcher"), { recursive: true });
	for (const file of ["index.mjs", "ui.html"]) {
		const src = path.join(LAUNCHER_DIR, file);
		if (!exists(src)) {
			throw new Error(
				`launcher/${file} is missing — the launcher UI must exist before packaging.`,
			);
		}
		fs.copyFileSync(src, path.join(PACKAGE_DIR, "launcher", file));
	}

	await ensureNodeRuntime(path.join(PACKAGE_DIR, "node"), opts.nodeVersion);

	const exeBuilt = buildLauncherExe();
	writeCmdFallback();
	fs.writeFileSync(path.join(PACKAGE_DIR, "README.txt"), readmeText(), "utf8");

	const zipPath = opts.zip ? makeZip() : null;
	printSummary(zipPath, exeBuilt);
	log("Done.");
}

main().catch((err) => {
	console.error("");
	console.error(`[build-windows] FAILED: ${err.message}`);
	if (process.env.NOTGT_DEBUG) console.error(err.stack);
	process.exitCode = 1;
});
