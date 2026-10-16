/**
 * NDI outputs: an out can also go out as an NDI source, for the programs that
 * take NDI and not a web page — Resolume Arena, vMix, TriCaster, OBS with the
 * NDI plugin.
 *
 * The server keeps the settings and what the senders report, nothing more.
 * The pictures are made by the NDI sender (`ndi/` at the root of the
 * repository): it renders the out page off screen — on this machine or on
 * another one, a Raspberry Pi included — and asks `GET /api/ndi` what to send.
 */
import type { Out } from "./types";

/** How an out goes out over NDI. Absent = it does not. */
export interface OutNdi {
	enabled: boolean;
	/** The name receivers list. Empty = `notGT <out name>`. */
	name?: string;
	/** Frames per second; the picture is only sent when something moves. */
	fps?: number;
	/** Picture size as a share of the out's own size: smaller costs much less to send. */
	scale?: number;
	/**
	 * Send the transparency (default). Off, the picture goes out opaque, over
	 * black — lighter to send and to receive, for a receiver that keys or
	 * does not need the alpha.
	 */
	alpha?: boolean;
	/** NDI groups the source is in, comma separated. Empty = NDI's default (`public`). */
	groups?: string;
}

/** The broadcast rates: 23.976, 29.97 and 59.94 go out as 24000/1001, 30000/1001, 60000/1001. */
export const NDI_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
export const NDI_DEFAULT_FPS = 30;
export const NDI_SCALES = [1, 0.75, 2 / 3, 0.5, 1 / 3] as const;

/**
 *   loading — the out page is being opened;
 *   idle    — ready, nobody receives it (and so it costs next to nothing);
 *   sending — at least one receiver;
 *   error   — the page or NDI failed; `error` says why.
 */
export type NdiState = "loading" | "idle" | "sending" | "error";

export interface NdiOutStatus {
	id: string;
	ndiName: string;
	state: NdiState;
	/** How many receivers watch the source. */
	connections: number;
	/** Frames sent per second lately: low while nothing moves. */
	fps: number;
	width: number;
	height: number;
	error?: string;
	/** It is sent, but not as asked — e.g. smaller than the out. */
	warning?: string;
}

/** What one sender said last. */
export interface NdiSenderStatus {
	id: string;
	host: string;
	/** `linux-arm64`, `win32-x64`… */
	platform: string;
	version: string;
	/** Version of the NDI library it runs on. */
	ndi: string;
	/** When it reported, server time (ms). */
	seenAt: number;
	outs: NdiOutStatus[];
}

/** senderId -> its last report; senders that stopped reporting drop out. */
export type NdiStatus = Record<string, NdiSenderStatus>;

/** A sender that has not reported for this long is taken as gone. */
export const NDI_SENDER_TTL_MS = 10_000;

/** What the sender is asked to send for one out (`GET /api/ndi`). */
export interface NdiOutConfig {
	id: string;
	name: string;
	ndiName: string;
	/** The out page, relative to the server, with the out's key when it needs one. */
	url: string;
	/** Size the page lays out at: the out's own. */
	designWidth: number;
	designHeight: number;
	/** Size of the NDI picture. */
	width: number;
	height: number;
	fps: number;
	/** `false`: send it opaque, over black. */
	alpha: boolean;
	/** NDI groups; absent = the default one. */
	groups?: string;
}

export function ndiSourceName(out: Pick<Out, "name" | "ndi">): string {
	return out.ndi?.name?.trim() || `notGT ${out.name}`;
}

/** Even: NDI compresses pixel pairs. */
function even(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

export function ndiScale(out: Pick<Out, "ndi">): number {
	const scale = out.ndi?.scale;
	return typeof scale === "number" && scale > 0 && scale <= 1 ? scale : 1;
}

export function ndiSize(out: Pick<Out, "width" | "height" | "ndi">): { width: number; height: number } {
	const scale = ndiScale(out);
	return { width: even(out.width * scale), height: even(out.height * scale) };
}

export function ndiAlpha(out: Pick<Out, "ndi">): boolean {
	return out.ndi?.alpha !== false;
}

/** Group names as NDI takes them: letters, digits, `-`, `_`, `.` and spaces, comma separated. */
export function cleanNdiGroups(value: string): string {
	return value
		.split(",")
		.map((group) => group.trim().replace(/[^\p{L}\p{N} ._-]/gu, ""))
		.filter(Boolean)
		.join(", ")
		.slice(0, 200);
}

/** "29.97 fps" for the rates NDI sends as N/1001. */
export function ndiFpsLabel(fps: number): string {
	return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 1000) / 1000);
}

export function ndiFps(out: Pick<Out, "ndi">): number {
	const fps = out.ndi?.fps;
	return typeof fps === "number" && fps >= 1 && fps <= 60 ? fps : NDI_DEFAULT_FPS;
}

/** NDI settings from an API client or an older out: `undefined` when there are none. */
export function normalizeNdi(value: unknown): OutNdi | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const ndi: OutNdi = { enabled: input["enabled"] === true };
	if (typeof input["name"] === "string" && input["name"].trim()) ndi.name = input["name"].trim().slice(0, 120);
	const fps = Number(input["fps"]);
	if (Number.isFinite(fps) && fps >= 1 && fps <= 60) ndi.fps = fps;
	const scale = Number(input["scale"]);
	if (Number.isFinite(scale) && scale > 0 && scale <= 1) ndi.scale = scale;
	if (input["alpha"] === false) ndi.alpha = false;
	if (typeof input["groups"] === "string") {
		const groups = cleanNdiGroups(input["groups"]);
		if (groups) ndi.groups = groups;
	}
	return ndi;
}

/** The reports about one out, from every sender that has it. */
export function ndiReportsFor(
	status: NdiStatus | undefined,
	outId: string,
): Array<{ sender: NdiSenderStatus; out: NdiOutStatus }> {
	const reports: Array<{ sender: NdiSenderStatus; out: NdiOutStatus }> = [];
	for (const sender of Object.values(status ?? {})) {
		const out = sender.outs.find((candidate) => candidate.id === outId);
		if (out) reports.push({ sender, out });
	}
	return reports;
}
