/**
 * scripts/windows-app.mjs — what goes into `app/` of the Windows package.
 *
 * A plain `npm ci --omit=dev` tree is ~36,000 files, and on Windows it is the
 * number of files, not their size, that makes unpacking and the first start
 * slow. So the server is not shipped as a tree:
 *
 *   - the NodeCG server and everything it requires are bundled into one file;
 *   - what cannot be bundled stays on disk: packages with a native addon (the
 *     addon is found relative to the package) and the packages they need at
 *     run time, plus the few files the dashboard fetches out of `node_modules`;
 *   - docs, type declarations, source maps and native build leftovers are
 *     dropped from what does stay;
 *   - the licences of everything that went into the bundle are collected into
 *     one text file, since their own files no longer travel with them.
 *
 * `build-windows.mjs` drives this; nothing here knows about the package layout
 * beyond `app/`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const BUILTINS = new Set(builtinModules);

/**
 * Replaced by a stub in the bundle.
 *
 * `express-transform-bare-module-specifiers` rewrites a bundle's bare imports
 * with Babel at request time; NodeCG loads it at start-up whether or not any
 * bundle asked for it, and it drags the whole of Babel in. The feature is
 * deprecated upstream and notGT does not use it.
 *
 * `pkginfo` copies fields of the calling module's `package.json` onto its
 * exports, finding that file through `module.filename` — which a module
 * inside a bundle does not have. The passport strategies use it only to
 * export their own version.
 */
const STUBS = {
	pkginfo: `"use strict";
function pkginfo() {
	return {};
}
pkginfo.read = () => ({ dir: "", package: {} });
pkginfo.find = () => "";
module.exports = pkginfo;
`,
	"express-transform-bare-module-specifiers": `"use strict";
let warned = false;
function transformBareModuleSpecifiers() {
	return function passThrough(_req, _res, next) {
		if (!warned) {
			warned = true;
			console.warn(
				"[notGT] transformBareModuleSpecifiers is not available in the portable Windows build; files are served as they are.",
			);
		}
		next();
	};
}
module.exports = transformBareModuleSpecifiers;
module.exports.default = transformBareModuleSpecifiers;
`,
};

/**
 * Kept on disk although they are plain JavaScript, because they load their own
 * files by a name put together at run time, which a bundler cannot follow.
 * `shelljs` requires each of its commands that way (`"./src/" + name`).
 */
const UNBUNDLED = new Set(["shelljs"]);

/**
 * Left out of the package altogether: required lazily, for something the
 * portable build does not do. `cosmiconfig` asks for `typescript` only to read
 * a config file written in TypeScript — and it is several megabytes.
 */
const LEFT_OUT = new Set(["typescript"]);

/**
 * Files a bundled package reads at run time by a path relative to itself.
 * Inside the bundle "itself" is the bundle, so they are put where the bundle
 * will look: `to` is relative to the bundle's directory.
 *   - socket.io serves its browser client from `../client-dist/`;
 *   - hasha hashes a file in a worker thread started from `thread.js`.
 */
const SIDE_FILES = [
	{ package: "socket.io", from: "client-dist", to: "../client-dist", suffix: ".js" },
	{ package: "hasha", from: "thread.js", to: "thread.js" },
];

/** Needed to install a native addon, never to load it. */
const INSTALL_ONLY = new Set(["prebuild-install", "node-gyp", "node-addon-api", "nan"]);

/**
 * Files the dashboard fetches straight from `/node_modules/...`. The server
 * looks them up on disk, so they are copied as they are.
 */
export const BROWSER_FILES = [
	"soundjs/lib/soundjs.min.js",
	"@sentry/browser/build/bundle.es6.min.js",
];

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** `@scope/name/sub/path` → `@scope/name`. */
function packageNameOf(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const packageRoots = new Map();

/**
 * The package a file belongs to: the nearest directory above it whose
 * `package.json` has a name. (A `dist/cjs/package.json` that only says
 * `{"type": "commonjs"}` is not a package.)
 */
function packageOf(file) {
	const walked = [];
	let found = null;
	for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
		if (packageRoots.has(dir)) {
			found = packageRoots.get(dir);
			break;
		}
		walked.push(dir);
		const manifest = readJson(path.join(dir, "package.json"));
		if (manifest?.name) {
			found = {
				dir,
				name: manifest.name,
				version: manifest.version ?? "",
				license: typeof manifest.license === "string" ? manifest.license : "",
			};
			break;
		}
		if (path.dirname(dir) === dir) break;
	}
	for (const dir of walked) packageRoots.set(dir, found);
	return found;
}

const nativeCache = new Map();

/** True when the package builds or carries a `.node` addon. */
function hasNativeAddon(dir) {
	if (nativeCache.has(dir)) return nativeCache.get(dir);
	let native = fs.existsSync(path.join(dir, "binding.gyp"));
	const walk = (current, depth) => {
		if (native || depth > 4) return;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			if (entry.isDirectory()) walk(path.join(current, entry.name), depth + 1);
			else if (entry.name.endsWith(".node")) native = true;
			if (native) return;
		}
	};
	if (!native) walk(dir, 0);
	nativeCache.set(dir, native);
	return native;
}

/** Where `name` is installed, as seen from `fromDir` — Node's own lookup. */
function installedDir(name, fromDir) {
	for (let dir = fromDir; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);
		if (fs.existsSync(path.join(candidate, "package.json"))) {
			return fs.realpathSync(candidate);
		}
		if (path.dirname(dir) === dir) return null;
	}
}

// ---------------------------------------------------------------------------
// The server as one file
// ---------------------------------------------------------------------------

function loadEsbuild(searchFrom) {
	for (const from of searchFrom) {
		try {
			return createRequire(path.join(from, "package.json"))("esbuild");
		} catch {
			// Try the next place.
		}
	}
	throw new Error(
		"esbuild is not installed. It is one of the notGT bundle's build tools: run `npm ci` in bundles/notGT.",
	);
}

/**
 * Bundles the server at `entry` into `outFile`.
 *
 * Module resolution starts from `entry`, so it must sit inside the tree whose
 * `node_modules` is the production install. Three kinds of import are left as
 * a run-time `require`:
 *   - Node's own modules;
 *   - packages with a native addon, and the few in `UNBUNDLED` — returned in
 *     `externals`, to be copied;
 *   - packages that are not installed — optional integrations (TypeORM's
 *     other database drivers, for one) that fail the same way they do today.
 */
export async function bundleServer({ entry, outFile, nodeMajor, esbuildFrom }) {
	const esbuild = loadEsbuild(esbuildFrom);
	const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-win-stub-"));
	const stubFiles = new Map();
	for (const [name, source] of Object.entries(STUBS)) {
		const file = path.join(stubDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.cjs`);
		fs.writeFileSync(file, source, "utf8");
		stubFiles.set(name, file);
	}

	const externals = new Map();
	const absent = new Set();

	const runtimeModules = {
		name: "notgt-runtime-modules",
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (args.pluginData?.resolving) return undefined;
				if (path.isAbsolute(args.path)) return undefined;
				const name = packageNameOf(args.path);
				if (args.path.startsWith("node:") || BUILTINS.has(name)) return undefined;
				if (stubFiles.has(name)) return { path: stubFiles.get(name) };
				if (LEFT_OUT.has(name)) return { path: args.path, external: true };

				const found = await build.resolve(args.path, {
					resolveDir: args.resolveDir,
					importer: args.importer,
					kind: args.kind,
					pluginData: { resolving: true },
				});
				if (found.errors.length > 0) {
					absent.add(name);
					return { path: args.path, external: true };
				}
				if (found.external) return { path: found.path, external: true };

				const owner = packageOf(found.path);
				if (owner && (hasNativeAddon(owner.dir) || UNBUNDLED.has(owner.name))) {
					externals.set(owner.name, owner.dir);
					return { path: args.path, external: true };
				}
				return {
					path: found.path,
					namespace: found.namespace,
					suffix: found.suffix,
					sideEffects: found.sideEffects,
					pluginData: found.pluginData,
				};
			});
		},
	};

	try {
		const result = await esbuild.build({
			entryPoints: [entry],
			outfile: outFile,
			absWorkingDir: path.dirname(entry),
			bundle: true,
			platform: "node",
			target: `node${nodeMajor}`,
			format: "cjs",
			// Not minified, and names kept: TypeORM names tables after its entity
			// classes, and merging modules into one scope renames the clashes.
			minify: false,
			keepNames: true,
			sourcemap: false,
			legalComments: "none",
			charset: "utf8",
			logLevel: "silent",
			// The code is already compiled; no tsconfig applies to it.
			tsconfigRaw: {},
			metafile: true,
			plugins: [runtimeModules],
			// An ES module that asks where it is gets the bundle's own location.
			define: { "import.meta.url": "__notgtBundleUrl" },
			banner: {
				js: 'const __notgtBundleUrl = require("node:url").pathToFileURL(__filename).href;',
			},
		});

		const packages = new Map();
		for (const input of Object.keys(result.metafile.inputs)) {
			const file = path.resolve(path.dirname(entry), input);
			if (!file.split(path.sep).includes("node_modules")) continue;
			const owner = packageOf(file);
			if (owner) packages.set(owner.dir, owner);
		}

		// How much of the bundle each package is, largest first.
		const weights = new Map();
		for (const [input, info] of Object.entries(Object.values(result.metafile.outputs)[0].inputs)) {
			const owner = packageOf(path.resolve(path.dirname(entry), input));
			const name = owner?.name ?? "(nodecg)";
			weights.set(name, (weights.get(name) ?? 0) + info.bytesInOutput);
		}

		return {
			externals,
			largest: [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
			absent: [...absent].sort(),
			packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
			bytes: fs.statSync(outFile).size,
			warnings: result.warnings.map((warning) => warning.text),
		};
	} finally {
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// What stays on disk
// ---------------------------------------------------------------------------

const DROPPED_DIRS = new Set([
	"test",
	"tests",
	"__tests__",
	"docs",
	"example",
	"examples",
	"benchmark",
	"benchmarks",
	".github",
]);
/** Sources and intermediates of a native build; the built `.node` is elsewhere. */
const NATIVE_BUILD_DIRS = new Set(["deps", "src", "obj", ".deps"]);
const DROPPED_SUFFIXES = [
	".map",
	".d.ts",
	".d.mts",
	".d.cts",
	".ts",
	".tsx",
	".mts",
	".cts",
	".tsbuildinfo",
	".md",
	".markdown",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".gyp",
	".gypi",
	".mk",
	".o",
	".obj",
	".a",
	".lib",
	".pdb",
	".ilk",
	".exp",
	".tlog",
	".lastbuildstate",
	".vcxproj",
	".filters",
	".sln",
];
const LICENCE_NAME = /^(licen[sc]e|copying|notice)(\.|-|$)/i;

/**
 * A `copyTree` filter that keeps what is needed to run a package and drops
 * the rest. Licence files always stay.
 */
export function runtimeFilesOf(packageDir) {
	const native = hasNativeAddon(packageDir);
	return (_full, name) => {
		if (name === "node_modules") return false;
		if (LICENCE_NAME.test(name)) return true;
		if (DROPPED_DIRS.has(name)) return false;
		if (native && NATIVE_BUILD_DIRS.has(name)) return false;
		if (name === "Makefile") return false;
		const lower = name.toLowerCase();
		return !DROPPED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
	};
}

/**
 * Copies what has to be on disk into `app/node_modules`: every external and,
 * transitively, what each one requires at run time — and the browser files.
 *
 * The bundle requires an external from its own place in `app/`, so the
 * externals go to the top of `app/node_modules` wherever npm had put them (a
 * workspace's own `node_modules`, for one). A dependency goes to the top too,
 * unless another version already has that name there; then it is nested under
 * the package that needs it, as npm would do.
 *
 * Optional dependencies count only when they are installed — that is how a
 * platform's own prebuilt addon is picked. Returns the names copied.
 */
export function copyRuntimeModules({ root, app, externals, copyTree }) {
	const modules = path.join(app, "node_modules");
	const topLevel = new Map(); // name → the real directory that took it
	const done = new Set();
	const copied = [];

	const place = (dir, neededBy) => {
		const real = fs.realpathSync(dir);
		const manifest = readJson(path.join(real, "package.json"));
		if (!manifest?.name) return;
		const taken = topLevel.get(manifest.name);
		const free = taken === undefined || taken === real;
		const home = path.join(free ? modules : path.join(neededBy, "node_modules"), manifest.name);
		if (free) topLevel.set(manifest.name, real);
		if (done.has(home)) return;
		done.add(home);

		copyTree(real, home, { keep: runtimeFilesOf(real) });
		copied.push(manifest.name);
		const needed = { ...manifest.dependencies, ...manifest.optionalDependencies };
		for (const name of Object.keys(needed)) {
			if (INSTALL_ONLY.has(name)) continue;
			const found = installedDir(name, real);
			if (found) place(found, home);
		}
	};
	for (const dir of externals.values()) place(dir, modules);

	const realRoot = fs.realpathSync(root);
	for (const file of BROWSER_FILES) {
		const from = path.join(realRoot, "node_modules", ...file.split("/"));
		if (!fs.existsSync(from)) continue;
		const to = path.join(modules, ...file.split("/"));
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);
		// With its manifest and licence, so the file is not an orphan.
		const owner = packageOf(from);
		if (!owner) continue;
		const home = path.join(modules, owner.name);
		for (const name of fs.readdirSync(owner.dir)) {
			if (name === "package.json" || LICENCE_NAME.test(name)) {
				fs.copyFileSync(path.join(owner.dir, name), path.join(home, name));
			}
		}
	}
	return [...new Set(copied)].sort();
}

/**
 * Puts the `SIDE_FILES` of the bundled `packages` next to the bundle.
 * Returns what was copied, relative to `bundleDir`.
 */
export function copySideFiles(packages, bundleDir) {
	const copied = [];
	for (const side of SIDE_FILES) {
		const owner = packages.find((pkg) => pkg.name === side.package);
		if (!owner) continue;
		const from = path.join(owner.dir, side.from);
		const to = path.resolve(bundleDir, side.to);
		if (!fs.existsSync(from)) {
			throw new Error(`${side.package} no longer has ${side.from}; check SIDE_FILES`);
		}
		if (fs.statSync(from).isDirectory()) {
			fs.mkdirSync(to, { recursive: true });
			for (const name of fs.readdirSync(from)) {
				if (side.suffix && !name.endsWith(side.suffix)) continue;
				fs.copyFileSync(path.join(from, name), path.join(to, name));
				copied.push(path.join(side.to, name));
			}
		} else {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
			copied.push(side.to);
		}
	}
	return copied;
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * One text file with the licence of every third-party package inside the
 * bundle: bundling removes their own licence files from the package, and most
 * of those licences ask that the notice travels with the code.
 */
export function writeLicences(file, packages) {
	const rule = "=".repeat(78);
	const parts = [
		"Third-party software in the notGT server",
		"",
		"The notGT Windows package ships the NodeCG server as a single bundled file.",
		"These are the packages inside it, each with its licence.",
		"",
	];
	let missing = 0;
	for (const pkg of packages) {
		const names = fs.readdirSync(pkg.dir).filter((name) => LICENCE_NAME.test(name));
		const texts = names
			.map((name) => path.join(pkg.dir, name))
			.filter((full) => fs.statSync(full).isFile())
			.map((full) => fs.readFileSync(full, "utf8").trim());
		if (texts.length === 0) missing += 1;
		parts.push(
			rule,
			`${pkg.name} ${pkg.version}${pkg.license ? ` — ${pkg.license}` : ""}`,
			rule,
			"",
			texts.length > 0
				? texts.join("\n\n")
				: `(No licence file in the package; its manifest says: ${pkg.license || "nothing"}.)`,
			"",
		);
	}
	fs.writeFileSync(file, parts.join("\n"), "utf8");
	return { packages: packages.length, withoutFile: missing };
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the packaged server and makes sure it really works: the dashboard,
 * the out page, the notGT API, a file served from `node_modules`, a write to
 * the store, and that the write is still there after a restart (the database
 * is the native addon). Runs on a copy of `app/`, so the package itself
 * stays free of a database and logs.
 *
 * `node` must match the platform the dependencies were installed for.
 */
export async function smokeTest({ app, node, copyTree, log }) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "notgt-win-smoke-"));
	const copy = path.join(work, "app");
	const port = 19090 + (process.pid % 400);
	const base = `http://127.0.0.1:${port}`;
	copyTree(app, copy);
	fs.writeFileSync(
		path.join(copy, "cfg", "nodecg.json"),
		JSON.stringify({ host: "127.0.0.1", port }),
		"utf8",
	);

	let output = "";
	const start = async () => {
		// The pages below are fetched without signing in.
		const child = spawn(node, ["index.js"], {
			cwd: copy,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NOTGT_LOGIN: "off" },
		});
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		for (let attempt = 0; attempt < 120; attempt += 1) {
			if (child.exitCode !== null) throw new Error("the server exited while starting");
			try {
				if ((await fetch(`${base}/api/health`)).ok) return { child, exited };
			} catch {
				// Not listening yet.
			}
			await sleep(500);
		}
		child.kill();
		throw new Error("the server did not answer within 60 s");
	};
	const stop = async ({ child, exited }) => {
		child.kill();
		await Promise.race([exited, sleep(5000)]);
	};

	const expect = async (label, check) => {
		const detail = await check();
		if (detail !== true) throw new Error(`${label}: ${detail}`);
		log(`  [ok] ${label}`);
	};
	const page = (url, needle) => async () => {
		const response = await fetch(`${base}${url}`);
		if (!response.ok) return `HTTP ${response.status} for ${url}`;
		if (needle && !(await response.text()).includes(needle)) return `"${needle}" not in ${url}`;
		return true;
	};
	const marker = `smoke-${Date.now()}`;

	try {
		log(`Smoke test: starting the packaged server with ${node}…`);
		let server = await start();
		try {
			await expect("the server starts and answers", page("/api/health"));
			await expect("the dashboard shell", page("/dashboard/", "ncg-dashboard"));
			await expect("a notGT panel", page("/bundles/notGT/dashboard/control.html?standalone=1", "notgt-root"));
			await expect("the out page", page("/bundles/notGT/graphics/out.html?out=main", "notgt-stage"));
			await expect("the brand fonts", page("/bundles/notGT/graphics/fonts/fonts.css", "Montserrat"));
			await expect("a file from node_modules", page(`/node_modules/${BROWSER_FILES[0]}`));
			await expect("the socket.io client", page("/socket.io/socket.io.js", "socket.io"));
			await expect("the example library was seeded", async () => {
				const body = await (await fetch(`${base}/api/templates`)).json();
				return body.templates?.length > 0 ? true : "no templates";
			});
			await expect("a variable can be written", async () => {
				const response = await fetch(`${base}/api/data?mode=merge`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ smoke: { marker } }),
				});
				return response.ok ? true : `HTTP ${response.status}`;
			});
			// Persistence is written a moment after the change.
			await sleep(1500);
		} finally {
			await stop(server);
		}

		server = await start();
		try {
			await expect("the database kept it across a restart", async () => {
				const body = await (await fetch(`${base}/api/data`)).json();
				return body.data?.smoke?.marker === marker ? true : JSON.stringify(body.data?.smoke);
			});
		} finally {
			await stop(server);
		}
		log("Smoke test passed.");
	} catch (error) {
		const tail = output.split(/\r?\n/).slice(-25).join("\n");
		throw new Error(`Smoke test failed — ${error.message}\n--- server output ---\n${tail}`);
	} finally {
		// Windows lets go of a killed process's files a moment later; a temp
		// folder that will not go away is not a reason to fail the build.
		try {
			fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		} catch {
			log(`  (left behind: ${work})`);
		}
	}
}
