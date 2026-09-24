import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BUNDLE_NAME } from "../shared/types";

/** Where served URLs live on disk. */
export interface MediaRoots {
	/** `<runtimeRoot>/assets` — what `/assets/...` maps to. */
	assetsDir: string;
	/** `<bundle>/graphics` — what `/bundles/<bundle>/graphics/...` maps to. */
	graphicsDir: string;
}

const cache = new Map<string, { mtimeMs: number; durationMs: number } | null>();

/**
 * Maps a layer `src` to a file on disk, or `undefined` when it is not a local
 * file (http(s), data URI), or when it uses a `{{...}}` binding we cannot
 * resolve outside the browser.
 */
export function resolveMediaPath(
	src: string | undefined,
	roots: MediaRoots,
): string | undefined {
	if (!src) return undefined;
	const value = src.trim();
	if (!value || value.includes("{{")) return undefined;
	if (/^(data|blob|https?):/i.test(value)) return undefined;

	// Served URLs are percent-encoded (our own uploads keep non-Latin file names),
	// so the path segment has to be decoded before touching the filesystem.
	const decode = (segment: string): string => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	};

	const assetsPrefix = "/assets/";
	if (value.startsWith(assetsPrefix)) {
		return path.join(roots.assetsDir, decode(value.slice(assetsPrefix.length)));
	}

	const graphicsPrefix = `/bundles/${BUNDLE_NAME}/graphics/`;
	if (value.startsWith(graphicsPrefix)) {
		return path.join(roots.graphicsDir, decode(value.slice(graphicsPrefix.length)));
	}

	return undefined;
}

/**
 * Length of a video file in milliseconds, probed with ffprobe and cached per
 * file+mtime. Returns `undefined` when the file is missing, not a local file,
 * or ffprobe is unavailable — callers fall back to the configured hold time.
 */
export function probeDurationMs(
	src: string | undefined,
	roots: MediaRoots,
): number | undefined {
	const file = resolveMediaPath(src, roots);
	if (!file) return undefined;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return undefined;
	}

	const hit = cache.get(file);
	if (hit && hit.mtimeMs === stat.mtimeMs) return hit.durationMs;

	const res = spawnSync(
		"ffprobe",
		[
			"-v", "error",
			"-select_streams", "v:0",
			"-show_entries", "format=duration",
			"-of", "default=noprint_wrappers=1:nokey=1",
			file,
		],
		{ encoding: "utf8", timeout: 20_000 },
	);
	const seconds = Number((res.stdout ?? "").trim());
	const durationMs =
		Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;

	cache.set(file, durationMs ? { mtimeMs: stat.mtimeMs, durationMs } : null);
	return durationMs;
}
