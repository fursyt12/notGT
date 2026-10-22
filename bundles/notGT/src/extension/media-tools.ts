import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The environment to run ffmpeg and ffprobe in. The Windows launcher installs
 * an ffmpeg of its own and names its folder in NOTGT_FFMPEG_DIR; that folder
 * goes first on PATH. It is looked at on every call, so an ffmpeg installed
 * while the server runs is used without a restart.
 */
export function mediaToolEnv(): NodeJS.ProcessEnv {
	const dir = process.env["NOTGT_FFMPEG_DIR"];
	if (!dir || !fs.existsSync(dir)) return process.env;
	// Windows spells it `Path`; a second `PATH` next to it would be a coin toss.
	const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
	const current = process.env[key];
	return { ...process.env, [key]: current ? `${dir}${path.delimiter}${current}` : dir };
}

/** ffmpeg runs here: the upload conversion and the renders need it. */
export function ffmpegAvailable(): boolean {
	const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", env: mediaToolEnv() });
	return res.status === 0;
}
