/**
 * Renders an animation of a notGT server on this machine, with this machine's
 * browser and ffmpeg: for a server that cannot render by itself, or to keep
 * the work off the machine that runs the show. The server needs notGT 0.16.0
 * or newer; it is only read from, nothing goes on air.
 *
 *   npm run render -- --server http://192.168.1.20:9090 --user admin --password admin \
 *       --title "Lower third" --format dxv --fps 25 --hold 5
 *   npm run render -- --server … --title "Side" --loop      one cycle that loops seamlessly
 *   npm run render -- --server … --list                    the animations there
 *
 * Built to extension/render-cli.js; `npm run render` in bundles/notGT runs it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { RENDER_FORMATS, RENDER_FPS, RENDER_MAX_HOLD_MS, type RenderFormat } from "../shared/render";
import type { Out, TitleTemplate } from "../shared/types";
import { ffmpegAvailable } from "./media-tools";
import { exitEstimate, fileBase } from "./render";
import { findBrowsers } from "./render-browser";
import { renderToFile } from "./render-job";

const HELP = `Renders an animation of a notGT server here, with this machine's browser and ffmpeg.

  --server URL         the notGT server, e.g. http://192.168.1.20:9090
  --user NAME          sign in as this user (with --password, or NOTGT_PASSWORD)
  --password TEXT
  --token TEXT         or the API token of the server (apiToken in notGT.json)
  --list               list the animations and stop
  --title NAME         the animation to render, by name
  --id ID              …or by id
  --format FORMAT      webm (VP9), prores (ProRes 4444) or dxv (DXV3); default webm
  --fps N              ${RENDER_FPS.join(", ")}; default 25
  --hold SECONDS       time on screen between the entrance and the exit; default 5
  --loop               one cycle of what moves on air, without the entrance and the
                       exit, that plays on in a loop without a jump
  --length SECONDS     the loop's length; without it, found from the animation
  --out FILE           where to write; default a name like the Editor's, here
  --out-id ID          the out whose link opens the page; default the first
  --browser PATH       Chromium, Chrome or Edge to use; default the first found
`;

/** Node 20 has the WebSocket the renderer talks to the browser with behind a flag. */
function needsWebSocketFlag(): boolean {
	if (typeof WebSocket !== "undefined") return false;
	const result = spawnSync(
		process.execPath,
		["--experimental-websocket", ...process.execArgv, __filename, ...process.argv.slice(2)],
		{ stdio: "inherit" },
	);
	process.exit(result.status ?? 1);
}

function fail(message: string): never {
	console.error(`notGT render: ${message}`);
	process.exit(1);
}

async function signIn(server: string, user: string, password: string): Promise<string> {
	const jar = new Map<string, string>();
	const keep = (res: Response) => {
		for (const line of res.headers.getSetCookie()) {
			const pair = line.split(";")[0] ?? "";
			const eq = pair.indexOf("=");
			if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	};
	const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
	keep(await fetch(`${server}/login/`, { redirect: "manual" }));
	const res = await fetch(`${server}/login/local`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(), origin: server },
		body: new URLSearchParams({ username: user, password }),
	});
	keep(res);
	if (res.status >= 400 || /\/login/.test(res.headers.get("location") ?? "")) {
		fail("signing in failed: check --user and --password");
	}
	return cookie();
}

async function main(): Promise<void> {
	if (needsWebSocketFlag()) return;
	const { values } = parseArgs({
		options: {
			server: { type: "string" },
			user: { type: "string" },
			password: { type: "string" },
			token: { type: "string" },
			list: { type: "boolean" },
			title: { type: "string" },
			id: { type: "string" },
			format: { type: "string", default: "webm" },
			fps: { type: "string", default: "25" },
			hold: { type: "string", default: "5" },
			loop: { type: "boolean" },
			length: { type: "string" },
			out: { type: "string" },
			"out-id": { type: "string" },
			browser: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help || !values.server) {
		console.log(HELP);
		process.exit(values.help ? 0 : 1);
	}

	const server = values.server.replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	if (values.token) headers["authorization"] = `Bearer ${values.token}`;
	else if (values.user) {
		const password = values.password ?? process.env["NOTGT_PASSWORD"];
		if (password === undefined) fail("--user needs --password (or NOTGT_PASSWORD)");
		headers["cookie"] = await signIn(server, values.user, password);
	}
	const api = async <T>(route: string): Promise<T> => {
		const res = await fetch(`${server}${route}`, { headers, redirect: "manual" });
		if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
			fail("the server wants a sign-in: give --user and --password, or --token");
		}
		if (!res.ok) fail(`${route}: HTTP ${res.status}`);
		return (await res.json()) as T;
	};

	const { templates } = await api<{ templates: TitleTemplate[] }>("/api/templates");
	if (values.list) {
		for (const t of templates) console.log(`${t.id}\t${t.width}×${t.height}\t${t.kind}\t${t.name}`);
		return;
	}
	const wanted = values.title?.trim().toLowerCase();
	const matches = values.id
		? templates.filter((t) => t.id === values.id)
		: wanted
			? (() => {
					const exact = templates.filter((t) => t.name.trim().toLowerCase() === wanted);
					return exact.length > 0 ? exact : templates.filter((t) => t.name.toLowerCase().includes(wanted));
				})()
			: [];
	if (!values.id && !wanted) fail("name the animation with --title or --id (--list shows them)");
	if (matches.length === 0) fail(`no animation ${values.id ?? `“${values.title}”`} on the server (--list shows them)`);
	if (matches.length > 1) fail(`“${values.title}” is more than one animation: ${matches.map((t) => t.name).join(", ")}; use --id`);
	const template = matches[0]!;

	const format = values.format as RenderFormat;
	if (!(format in RENDER_FORMATS)) fail(`unknown format ${values.format}: webm, prores or dxv`);
	const fps = Number(values.fps);
	if (!RENDER_FPS.includes(fps as (typeof RENDER_FPS)[number])) fail(`--fps is one of ${RENDER_FPS.join(", ")}`);
	const holdMs = Math.round(Number(values.hold) * 1000);
	if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > RENDER_MAX_HOLD_MS) fail("--hold is out of range");
	const cycleMs = values.length ? Math.round(Number(values.length) * 1000) : 0;
	if (!Number.isFinite(cycleMs) || cycleMs < 0 || cycleMs > RENDER_MAX_HOLD_MS) fail("--length is out of range");
	const mode = values.loop ? "loop" : "play";
	if (RENDER_FORMATS[format].ffmpeg && !ffmpegAvailable()) fail(`${format} needs ffmpeg here, and there is none`);
	const browsers = values.browser ? [values.browser] : findBrowsers();
	if (browsers.length === 0) fail("no Chromium, Chrome or Edge here: install one, or name it with --browser");

	// An out's own link opens the page, its key and all, when the sign-in is on.
	const { outs } = await api<{ outs: Out[] }>("/api/outs");
	const out = values["out-id"] ? outs.find((o) => o.id === values["out-id"]) : outs[0];
	if (values["out-id"] && !out) fail(`no out ${values["out-id"]} on the server`);
	const link = out
		? (await api<{ url: string }>(`/api/outs/${encodeURIComponent(out.id)}/url`)).url
		: "/bundles/notGT/graphics/out.html";
	const url = new URL(link, server);
	url.searchParams.set("render", template.id);

	const ext = RENDER_FORMATS[format].ext;
	let file = values.out ?? path.resolve(fileBase(template.name, { ...template, fps, format, mode }) + ext);
	if (!values.out) {
		for (let n = 2; fs.existsSync(file); n++) {
			file = path.resolve(`${fileBase(template.name, { ...template, fps, format, mode })}-${n}${ext}`);
		}
	}

	console.log(
		`${template.name} (${template.width}×${template.height}) → ${file}\n` +
			`${RENDER_FORMATS[format].label}, ${fps} fps, ${mode === "loop" ? "one loop" : `${holdMs / 1000} s on screen`}; ` +
			`drawn by ${browsers[0]}`,
	);
	const started = Date.now();
	const outcome = await renderToFile(
		browsers,
		url.href,
		{ format, fps, width: template.width, height: template.height, mode, holdMs, cycleMs, exitMs: exitEstimate(template) },
		file,
		{
			progress: (frames, fraction) => process.stderr.write(`\rframe ${frames} (${Math.round(fraction * 100)}%)   `),
			cancelled: () => false,
		},
	);
	const bytes = fs.statSync(file).size;
	process.stderr.write("\n");
	console.log(
		`done: ${outcome.frames} frames, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`,
	);
	if (outcome.cycleMs !== undefined) {
		console.log(`loop: ${(outcome.cycleMs / 1000).toFixed(2)} s`);
		const frameMs = 1000 / fps;
		if ((outcome.missMs ?? 0) > frameMs / 2) {
			console.log(
				`  not every part comes round within it: one that repeats every ` +
					`${((outcome.missPeriodMs ?? 0) / 1000).toFixed(2)} s is ${Math.round(outcome.missMs ?? 0)} ms off ` +
					`where the file starts over`,
			);
			if (outcome.exactMs !== undefined) {
				const seconds = Number((outcome.exactMs / 1000).toFixed(2));
				console.log(`  every part comes round after ${seconds} s: --length ${seconds} makes an exact loop`);
			}
		}
	}
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
