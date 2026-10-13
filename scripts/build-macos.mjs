#!/usr/bin/env node
/**
 * scripts/build-macos.mjs — portable macOS package builder for notGT.
 *
 * Produces `notGT-macos-<arch>/` and (unless --no-zip) `notGT-macos-<arch>.zip`:
 *
 *   notGT-macos-arm64/
 *     notGT Launcher.app      the launcher's window (clang; built on macOS only)
 *     notGT.command           fallback: the same controls as a page in the browser
 *     launcher/index.mjs      control UI + server supervisor
 *     launcher/ui.html
 *     node/node               official macOS Node runtime (nothing else of it)
 *     app/                    NodeCG runtime root — the same tree the Windows
 *                             package has, see build-windows.mjs
 *     README.txt
 *
 * `app/` is assembled by `build-windows.mjs --app-only`, so the two packages
 * cannot drift apart. The only thing in it that belongs to one system is the
 * native database driver, which is the one of the machine that builds — so a
 * package that runs is built on macOS, on the architecture it is for. On Linux
 * the script still lays everything out, without the window and with a warning.
 *
 * Usage:
 *   node scripts/build-macos.mjs [--node-version 22.14.0] [--out dist]
 *                                [--arch arm64|x64] [--skip-build] [--no-zip]
 *                                [--smoke]
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { smokeTest } from "./windows-app.mjs";

// ---------------------------------------------------------------------------
// Constants / CLI
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const IS_MAC = process.platform === "darwin";

const APP_NAME = "notGT Launcher.app";
const EXECUTABLE = "notGT-launcher";
const LAUNCHER_DIR = path.join(REPO_ROOT, "launcher");
const MAC_DIR = path.join(LAUNCHER_DIR, "mac");
const NODE_DIST_BASE = "https://nodejs.org/dist";

function parseArgs(argv) {
	const opts = {
		nodeVersion: "22.14.0",
		out: "dist",
		arch: process.arch === "x64" ? "x64" : "arm64",
		skipBuild: false,
		zip: true,
		smoke: false,
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
			case "--arch":
				opts.arch = take();
				break;
			case "--skip-build":
				opts.skipBuild = true;
				break;
			case "--no-zip":
				opts.zip = false;
				break;
			case "--smoke":
				opts.smoke = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg} (try --help)`);
		}
	}
	if (!["arm64", "x64"].includes(opts.arch)) {
		throw new Error(`--arch must be arm64 or x64, not ${opts.arch}`);
	}
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
const OUT_ROOT = path.isAbsolute(opts.out) ? opts.out : path.join(REPO_ROOT, opts.out);
const PACKAGE_DIR_NAME = `notGT-macos-${opts.arch}`;
const PACKAGE_DIR = path.join(OUT_ROOT, PACKAGE_DIR_NAME);
const CACHE_DIR = path.join(OUT_ROOT, ".cache");
/** Whether what is built here can run: the native driver is this machine's. */
const NATIVE = IS_MAC && process.arch === opts.arch;

function log(message) {
	console.log(`[build-macos] ${message}`);
}

function warn(message) {
	console.warn(`[build-macos] WARNING: ${message}`);
}

function exists(p) {
	return fs.existsSync(p);
}

function human(bytes) {
	if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

/** Runs a command; throws with the end of what it printed when it fails. */
function run(command, args, { cwd = REPO_ROOT, quiet = false } = {}) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
		encoding: "utf8",
	});
	if (result.error) throw new Error(`${command}: ${result.error.message}`);
	if (result.status !== 0) {
		const tail = quiet
			? `\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n")}`
			: "";
		throw new Error(`${command} ${args.join(" ")} exited with ${result.status}${tail}`);
	}
	return result;
}

function commandExists(command) {
	return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function copyTree(src, dest) {
	fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

function version() {
	return JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, "bundles", "notGT", "package.json"), "utf8"),
	).version;
}

// ---------------------------------------------------------------------------
// 1. app/ — the same tree as in the Windows package
// ---------------------------------------------------------------------------

function assembleApp() {
	const stage = path.join(CACHE_DIR, "macos-app");
	fs.rmSync(stage, { recursive: true, force: true });
	log("Assembling app/ (build-windows.mjs --app-only)…");
	run(process.execPath, [
		path.join(__dirname, "build-windows.mjs"),
		"--app-only",
		"--out",
		stage,
		"--node-version",
		opts.nodeVersion,
		...(opts.skipBuild ? ["--skip-build"] : []),
	]);
	const app = path.join(stage, "notGT-win-x64", "app");
	if (!exists(path.join(app, "index.js"))) {
		throw new Error(`build-windows.mjs --app-only did not produce ${app}`);
	}
	fs.renameSync(app, path.join(PACKAGE_DIR, "app"));
	fs.rmSync(stage, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. Official macOS Node runtime
// ---------------------------------------------------------------------------

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		fs.createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

async function download(url, dest) {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
}

async function expectedNodeSha(nodeVersion, name) {
	const response = await fetch(`${NODE_DIST_BASE}/v${nodeVersion}/SHASUMS256.txt`);
	if (!response.ok) throw new Error(`SHASUMS256.txt -> HTTP ${response.status}`);
	for (const line of (await response.text()).split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
		if (match && match[2] === name) return match[1].toLowerCase();
	}
	throw new Error(`No SHA-256 entry for ${name} in SHASUMS256.txt`);
}

async function ensureNodeRuntime(destDir) {
	const inner = `node-v${opts.nodeVersion}-darwin-${opts.arch}`;
	const name = `${inner}.tar.gz`;
	const archive = path.join(CACHE_DIR, name);
	fs.mkdirSync(CACHE_DIR, { recursive: true });

	log(`Verifying ${name} against SHASUMS256.txt…`);
	const expected = await expectedNodeSha(opts.nodeVersion, name);
	if (!exists(archive) || (await sha256File(archive)) !== expected) {
		const part = `${archive}.part`;
		fs.rmSync(part, { force: true });
		log(`Downloading ${NODE_DIST_BASE}/v${opts.nodeVersion}/${name}…`);
		await download(`${NODE_DIST_BASE}/v${opts.nodeVersion}/${name}`, part);
		const actual = await sha256File(part);
		if (actual !== expected) {
			fs.rmSync(part, { force: true });
			throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
		}
		fs.renameSync(part, archive);
	}
	log(`SHA-256 OK: ${expected}`);

	const extractDir = path.join(CACHE_DIR, `extract-${inner}`);
	fs.rmSync(extractDir, { recursive: true, force: true });
	fs.mkdirSync(extractDir, { recursive: true });
	// Only the runtime itself: npm and corepack are thousands of files that
	// nothing in the package runs.
	run("tar", ["-xzf", archive, "-C", extractDir, `${inner}/bin/node`, `${inner}/LICENSE`]);
	fs.rmSync(destDir, { recursive: true, force: true });
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(path.join(extractDir, inner, "bin", "node"), path.join(destDir, "node"));
	fs.copyFileSync(path.join(extractDir, inner, "LICENSE"), path.join(destDir, "LICENSE"));
	fs.chmodSync(path.join(destDir, "node"), 0o755);
	fs.rmSync(extractDir, { recursive: true, force: true });
	log(`Node runtime placed in ${path.relative(REPO_ROOT, destDir)} (node only)`);
}

// ---------------------------------------------------------------------------
// 3. The launcher's window + the .command fallback
// ---------------------------------------------------------------------------

/**
 * Builds `notGT Launcher.app`. The program is compiled for both architectures:
 * it is small, and that way the same source serves an Intel package too. It is
 * signed ad hoc — a signature that says nothing about who made it, which is
 * what Apple silicon asks of any program before it runs it at all.
 */
function buildLauncherApp() {
	if (!IS_MAC) {
		warn(`not on macOS: "${APP_NAME}" was NOT built. This package is a layout check only.`);
		return false;
	}
	const bundle = path.join(PACKAGE_DIR, APP_NAME);
	const contents = path.join(bundle, "Contents");
	fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
	fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });

	fs.writeFileSync(
		path.join(contents, "Info.plist"),
		fs.readFileSync(path.join(MAC_DIR, "Info.plist"), "utf8").replaceAll("__VERSION__", version()),
		"utf8",
	);
	fs.writeFileSync(path.join(contents, "PkgInfo"), "APPL????", "utf8");
	fs.copyFileSync(
		path.join(MAC_DIR, "assets", "notgt.icns"),
		path.join(contents, "Resources", "notgt.icns"),
	);

	log(`Compiling ${APP_NAME}…`);
	run(
		"xcrun",
		[
			"clang",
			"-fobjc-arc",
			"-O2",
			"-Wall",
			"-mmacosx-version-min=11.0",
			"-arch",
			"arm64",
			"-arch",
			"x86_64",
			"-framework",
			"Cocoa",
			"-framework",
			"WebKit",
			"-o",
			path.join(contents, "MacOS", EXECUTABLE),
			path.join(MAC_DIR, "notGT-launcher.m"),
		],
		{ quiet: true },
	);
	run("codesign", ["--force", "--sign", "-", bundle], { quiet: true });
	return true;
}

function writeCommandFallback() {
	const script = [
		"#!/bin/bash",
		"# notGT launcher without the window: the same controls as a page in the browser.",
		"# Keep this file next to the node/ and launcher/ folders.",
		'cd "$(dirname "$0")" || exit 1',
		"if [ ! -x node/node ] || [ ! -f launcher/index.mjs ]; then",
		'  echo "node/node or launcher/index.mjs is missing: unpack the whole ZIP archive."',
		'  echo "Не найден node/node или launcher/index.mjs — распакуйте ZIP-архив целиком."',
		'  read -r -p "Press Return to close… " _',
		"  exit 1",
		"fi",
		'exec node/node launcher/index.mjs --app app "$@"',
		"",
	].join("\n");
	const file = path.join(PACKAGE_DIR, "notGT.command");
	fs.writeFileSync(file, script, "utf8");
	fs.chmodSync(file, 0o755);
}

// ---------------------------------------------------------------------------
// 4. README.txt
// ---------------------------------------------------------------------------

function readmeText() {
	const cpu = opts.arch === "arm64" ? "Apple silicon (M1 и новее)" : "Intel";
	return [
		"notGT — портативная сборка для macOS",
		"====================================",
		"",
		`Для Mac на процессорах ${cpu}, macOS 11 и новее.`,
		"Node.js устанавливать не нужно — он уже внутри.",
		"",
		"Запуск",
		"------",
		"1. Распакуйте ZIP-архив целиком в отдельную папку.",
		`2. Запустите «${APP_NAME.replace(".app", "")}» из этой папки. Не вынимайте программу`,
		"   из папки: рядом с ней лежат node, launcher и app.",
		"3. Выберите сетевой интерфейс и порт, нажмите «Запустить», затем «Открыть панель».",
		"4. Панель спросит имя и пароль. На новом сервере это admin / admin —",
		"   войдите и сразу смените пароль во вкладке «Команда».",
		"",
		"Первый запуск: macOS остановит программу",
		"----------------------------------------",
		"Сборка не подписана сертификатом разработчика Apple, поэтому при первом",
		"запуске macOS скажет, что не может её проверить. Любой из двух способов:",
		"",
		"  а) «Системные настройки» → «Конфиденциальность и безопасность» →",
		"     внизу «Всё равно открыть» (появляется после первой попытки запуска);",
		"",
		"  б) в Терминале, указав свою папку:",
		`       xattr -dr com.apple.quarantine ~/Downloads/${PACKAGE_DIR_NAME}`,
		"",
		"После разрешения программа сама снимает отметку карантина со своей папки —",
		"иначе macOS не даст серверу загрузить драйвер базы данных.",
		"",
		"Окно и сервер",
		"-------------",
		"Закрытие окна сервер не останавливает: он продолжает работать, и при",
		"следующем запуске окно покажет, что сервер запущен. Остановить сервер —",
		"кнопка «Остановить».",
		"",
		"notGT.command — запасной запуск без окна: то же управление страницей в",
		"браузере. Пока открыто окно Терминала, работает и сервер.",
		"",
		"OBS Browser Source",
		"------------------",
		"Адрес копируется в панели кнопкой «Ссылка для OBS» — у каждого выхода (out)",
		"он свой и содержит ключ этого выхода. Размер 1920x1080, прозрачный фон.",
		"",
		"Данные",
		"------",
		"Настройки и медиа лежат в app/cfg, app/db и app/assets. При обновлении",
		"распакуйте новую версию в новую папку и перенесите эти каталоги.",
		"",
		"In English",
		"----------",
		"Unpack the whole archive and start “notGT Launcher” from the unpacked",
		"folder. The build is not signed with an Apple developer certificate: on the",
		"first start allow it in System Settings → Privacy & Security → Open Anyway,",
		"or run in Terminal:",
		`    xattr -dr com.apple.quarantine ~/Downloads/${PACKAGE_DIR_NAME}`,
		"The dashboard asks for a name and a password: admin / admin on a new",
		"server — change it at once on the Team tab. Closing the window leaves the",
		"server running; “Stop” stops it. Your data is in app/cfg, app/db, app/assets.",
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// 5. Checks
// ---------------------------------------------------------------------------

/** Starts the packaged server with the packaged Node and looks at what it serves. */
async function runSmokeTest() {
	const packaged = path.join(PACKAGE_DIR, "node", "node");
	await smokeTest({
		app: path.join(PACKAGE_DIR, "app"),
		node: NATIVE ? packaged : process.execPath,
		copyTree,
		log,
	});
}

/**
 * Starts the window itself, on a copy of the package so that nothing it writes
 * ends up in the archive, and has it save a picture of what it shows (see
 * `--snapshot` in the launcher's source). A window that does not come up fails
 * the build; a picture that could not be taken is only a warning, because the
 * page was shown and that is what the check is for.
 */
function testLauncherWindow() {
	const work = fs.mkdtempSync(path.join(CACHE_DIR, "macos-window-"));
	const root = path.join(work, PACKAGE_DIR_NAME);
	const picture = path.join(OUT_ROOT, "macos-launcher.png");
	fs.rmSync(picture, { force: true });
	try {
		copyTree(PACKAGE_DIR, root);
		log("Window test: starting the launcher…");
		const result = spawnSync(
			path.join(root, APP_NAME, "Contents", "MacOS", EXECUTABLE),
			["--root", root, "--snapshot", picture],
			{ encoding: "utf8", timeout: 120_000 },
		);
		const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		if (said) console.log(said.split("\n").map((line) => `  ${line}`).join("\n"));
		if (result.status === 3) {
			warn("the launcher showed its page, but a picture of the window could not be taken");
			return;
		}
		if (result.status !== 0) {
			throw new Error(
				`the launcher's window did not come up (${
					result.error ? result.error.message : `exit ${result.status ?? result.signal}`
				})${said ? `:\n${said.split("\n").slice(-10).join("\n")}` : ""}`,
			);
		}
		log(`  [ok] the window shows the launcher's page (${path.relative(REPO_ROOT, picture)})`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 6. Zip + summary
// ---------------------------------------------------------------------------

function makeZip() {
	const zip = path.join(OUT_ROOT, `${PACKAGE_DIR_NAME}.zip`);
	fs.rmSync(zip, { force: true });
	log(`Creating ${path.relative(REPO_ROOT, zip)}…`);
	if (IS_MAC) {
		// ditto keeps what makes an application an application: the executable
		// bits, the symlinks and the signature's extended attributes.
		run("ditto", ["-c", "-k", "--keepParent", PACKAGE_DIR, zip]);
	} else {
		run("zip", ["-r", "-q", "-y", `${PACKAGE_DIR_NAME}.zip`, PACKAGE_DIR_NAME], { cwd: OUT_ROOT });
	}
	if (!exists(zip)) throw new Error(`zip was not created: ${zip}`);
	return zip;
}

function printSummary(zip, appBuilt) {
	const checks = [
		...(appBuilt
			? [[`${APP_NAME}/Contents/MacOS/${EXECUTABLE}`, path.join(PACKAGE_DIR, APP_NAME, "Contents", "MacOS", EXECUTABLE)]]
			: []),
		["notGT.command", path.join(PACKAGE_DIR, "notGT.command")],
		["launcher/index.mjs", path.join(PACKAGE_DIR, "launcher", "index.mjs")],
		["launcher/ui.html", path.join(PACKAGE_DIR, "launcher", "ui.html")],
		["node/node", path.join(PACKAGE_DIR, "node", "node")],
		["app/index.js", path.join(PACKAGE_DIR, "app", "index.js")],
		["app/node_modules/better-sqlite3", path.join(PACKAGE_DIR, "app", "node_modules", "better-sqlite3")],
		["app/bundles/notGT/extension/index.js", path.join(PACKAGE_DIR, "app", "bundles", "notGT", "extension", "index.js")],
	];
	console.log("");
	log(`Package: ${PACKAGE_DIR}`);
	let missing = 0;
	for (const [label, file] of checks) {
		const ok = exists(file);
		if (!ok) missing += 1;
		console.log(`  [${ok ? "ok     " : "MISSING"}] ${label}`);
	}
	if (zip) log(`Zip: ${zip} (${human(fs.statSync(zip).size)})`);
	if (missing > 0) throw new Error(`${missing} file(s) of the package are missing`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	if (opts.help) {
		console.log(
			"Usage: node scripts/build-macos.mjs [--node-version 22.14.0] [--out dist]\n" +
				"                                     [--arch arm64|x64] [--skip-build] [--no-zip] [--smoke]\n\n" +
				"  --smoke   start the packaged server, and on macOS the launcher's window too",
		);
		return;
	}

	log(`notGT macOS package builder (Node ${process.version}, ${process.platform}/${process.arch})`);
	log(`Package: ${PACKAGE_DIR_NAME}, Node runtime ${opts.nodeVersion}`);
	if (!NATIVE) {
		warn(
			`built on ${process.platform}/${process.arch}: the database driver in app/ is this machine's, ` +
				`so the package will not run on macOS/${opts.arch}. Build it there for a release.`,
		);
	}

	// Start clean so re-runs cannot leave stale files behind.
	fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
	fs.mkdirSync(PACKAGE_DIR, { recursive: true });
	fs.mkdirSync(CACHE_DIR, { recursive: true });

	assembleApp();

	fs.mkdirSync(path.join(PACKAGE_DIR, "launcher"), { recursive: true });
	for (const file of ["index.mjs", "ui.html"]) {
		fs.copyFileSync(path.join(LAUNCHER_DIR, file), path.join(PACKAGE_DIR, "launcher", file));
	}

	await ensureNodeRuntime(path.join(PACKAGE_DIR, "node"));

	const appBuilt = buildLauncherApp();
	writeCommandFallback();
	fs.writeFileSync(path.join(PACKAGE_DIR, "README.txt"), readmeText(), "utf8");

	if (opts.smoke) {
		await runSmokeTest();
		if (appBuilt && NATIVE) testLauncherWindow();
	}

	const zip = opts.zip ? makeZip() : null;
	printSummary(zip, appBuilt);
	if (!commandExists("ditto") && zip) {
		warn("zipped without ditto: build on macOS for an archive that keeps the application intact");
	}
	log("Done.");
}

main().catch((err) => {
	console.error("");
	console.error(`[build-macos] FAILED: ${err.message}`);
	// Shown on the run's page, where the log cannot always be read.
	if (process.env.GITHUB_ACTIONS) {
		console.log(`::error title=build-macos::${String(err.message).replace(/\r?\n/g, "%0A")}`);
	}
	if (process.env.NOTGT_DEBUG) console.error(err.stack);
	process.exitCode = 1;
});
