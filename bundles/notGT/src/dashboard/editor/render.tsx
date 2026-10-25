/**
 * "Render": the animation as a video file with an alpha channel — WebM VP9,
 * ProRes 4444 or DXV3 — made on the server (extension/render.ts) and
 * downloaded from here. The toolbar button shows the progress while a render
 * runs, also with the dialog closed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
	RENDER_FORMATS,
	RENDER_FPS,
	RENDER_MAX_HOLD_MS,
	type RenderFormat,
	type RenderJob,
	type RenderStatus,
} from "../../shared/render";
import { BUNDLE_NAME, type TitleTemplate } from "../../shared/types";
import { t } from "../i18n";
import { Icon, SecondsInput } from "../ui";
import { formatBytes } from "./ui";

const RENDER_BASE = `/bundles/${BUNDLE_NAME}/render`;
const FORMATS = Object.keys(RENDER_FORMATS) as RenderFormat[];

/** The choices of the last render, kept for the next one. */
function remembered<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
	try {
		const raw = window.localStorage.getItem(key);
		if (raw !== null) {
			const value = JSON.parse(raw) as unknown;
			if (valid(value)) return value as T;
		}
	} catch {
		// Storage is a convenience.
	}
	return fallback;
}

function remember(key: string, value: unknown): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage is a convenience.
	}
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
	if (!res.ok) throw new Error(json.message ?? json.error ?? t("The server returned HTTP {status}", { status: res.status }));
	return json;
}

function formatHint(format: RenderFormat, template: TitleTemplate | null, fps: number): string {
	if (format === "webm") return t("For OBS, browsers and notGT's own video layers.");
	if (format === "prores") return t("For editing: Premiere, DaVinci Resolve, Final Cut, After Effects.");
	// A DXV3 frame is its texture as it is: a byte per pixel of the padded picture.
	const perSecond = template
		? Math.ceil(template.width / 16) * 16 * Math.ceil(template.height / 4) * 4 * fps
		: 0;
	return perSecond > 0
		? t("For Resolume. Uncompressed: about {size} a second.", { size: formatBytes(perSecond) })
		: t("For Resolume.");
}

export function RenderButton({
	template,
	unsaved,
	disabled,
	prepare,
}: {
	/** What the Editor has open now. */
	template: TitleTemplate | null;
	unsaved: boolean;
	disabled: boolean;
	/** Saves what is unsaved and gives the animation to render. */
	prepare: () => TitleTemplate | null;
}) {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const pollRef = useRef<number | undefined>(undefined);
	const [status, setStatus] = useState<RenderStatus | null>(null);
	const [job, setJob] = useState<RenderJob | null>(null);
	const [error, setError] = useState("");
	const [format, setFormat] = useState<RenderFormat>(() =>
		remembered("notgt.render.format", "webm", (value) => typeof value === "string" && value in RENDER_FORMATS),
	);
	const [fps, setFps] = useState<number>(() =>
		remembered("notgt.render.fps", 25, (value) => RENDER_FPS.includes(value as (typeof RENDER_FPS)[number])),
	);
	const [holdMs, setHoldMs] = useState<number>(() =>
		remembered("notgt.render.holdMs", 5000, (value) => typeof value === "number" && value >= 0 && value <= RENDER_MAX_HOLD_MS),
	);
	const [mode, setMode] = useState<"play" | "loop">(() =>
		remembered("notgt.render.mode", "play", (value) => value === "play" || value === "loop"),
	);
	const [cycleMs, setCycleMs] = useState<number>(() =>
		remembered("notgt.render.cycleMs", 0, (value) => typeof value === "number" && value >= 0 && value <= RENDER_MAX_HOLD_MS),
	);

	const running = job?.state === "running";

	const poll = useCallback((id: string) => {
		window.clearTimeout(pollRef.current);
		const tick = async () => {
			try {
				const { job: next } = await request<{ job: RenderJob }>("GET", `${RENDER_BASE}/jobs/${encodeURIComponent(id)}`);
				setJob(next);
				if (next.state === "running") pollRef.current = window.setTimeout(tick, 500);
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
			}
		};
		void tick();
	}, []);

	useEffect(() => () => window.clearTimeout(pollRef.current), []);

	const open = async () => {
		dialogRef.current?.showModal();
		setError("");
		try {
			const next = await request<RenderStatus>("GET", `${RENDER_BASE}/status`);
			setStatus(next);
			if (next.job) {
				setJob(next.job);
				if (next.job.state === "running") poll(next.job.id);
			}
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	const start = async () => {
		setError("");
		const target = prepare();
		if (!target) return;
		remember("notgt.render.format", format);
		remember("notgt.render.fps", fps);
		remember("notgt.render.holdMs", holdMs);
		remember("notgt.render.mode", mode);
		remember("notgt.render.cycleMs", cycleMs);
		try {
			const { job: started } = await request<{ job: RenderJob }>("POST", `${RENDER_BASE}/jobs`, {
				templateId: target.id,
				format,
				fps,
				mode,
				holdMs,
				cycleMs,
			});
			setJob(started);
			poll(started.id);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	const stop = async () => {
		if (!job) return;
		try {
			await request("DELETE", `${RENDER_BASE}/jobs/${encodeURIComponent(job.id)}`);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	const percent = job ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : 0;
	const noBrowser = status !== null && status.browser === null;
	const needsFfmpeg = status !== null && !status.ffmpeg;
	const blocked = noBrowser || (needsFfmpeg && RENDER_FORMATS[format].ffmpeg);

	// Out of the toolbar, whose no-wrap and clipping it would inherit.
	const dialog = (
		<dialog
			ref={dialogRef}
			className="ed-render"
			onClose={() => setError("")}
			onClick={(event) => {
				// A click on the backdrop closes it.
				if (event.target === dialogRef.current) dialogRef.current?.close();
			}}
		>
			<form method="dialog" className="ed-render__body" onSubmit={(event) => event.preventDefault()}>
				<div className="ed-render__head">
					<strong>{t("Render to a video file")}</strong>
					<span className="muted truncate">
						{template ? `${template.name} · ${template.width}×${template.height}` : t("No animation open")}
					</span>
				</div>

				<div className="ed-render__row">
					<span className="ed-render__label">{t("Format")}</span>
					<div className="seg" role="radiogroup" aria-label={t("Format")}>
						{FORMATS.map((value) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={value === format}
								className={value === format ? "is-on" : undefined}
								disabled={running || (needsFfmpeg && RENDER_FORMATS[value].ffmpeg)}
								onClick={() => setFormat(value)}
								data-render-format={value}
							>
								{RENDER_FORMATS[value].label}
							</button>
						))}
					</div>
				</div>
				<div className="hint">{formatHint(format, template, fps)}</div>

				<div className="ed-render__row">
					<span className="ed-render__label">{t("Frame rate")}</span>
					<div className="seg" role="radiogroup" aria-label={t("Frame rate")}>
						{RENDER_FPS.map((value) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={value === fps}
								className={value === fps ? "is-on" : undefined}
								disabled={running}
								onClick={() => setFps(value)}
							>
								{value}
							</button>
						))}
					</div>
				</div>

				<div className="ed-render__row">
					<span className="ed-render__label">{t("Mode")}</span>
					<div className="seg" role="radiogroup" aria-label={t("Mode")}>
						{(["play", "loop"] as const).map((value) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={value === mode}
								className={value === mode ? "is-on" : undefined}
								disabled={running}
								onClick={() => setMode(value)}
								data-render-mode={value}
							>
								{value === "play" ? t("Play once") : t("Loop")}
							</button>
						))}
					</div>
				</div>

				{mode === "play" ? (
					<div className="ed-render__row">
						<span className="ed-render__label">{t("On screen")}</span>
						<SecondsInput
							valueMs={holdMs}
							minMs={0}
							disabled={running}
							label={t("On screen")}
							onCommit={(ms) => setHoldMs(Math.min(RENDER_MAX_HOLD_MS, ms))}
						/>
					</div>
				) : (
					<div className="ed-render__row">
						<span className="ed-render__label">{t("Loop length")}</span>
						<SecondsInput
							valueMs={cycleMs}
							minMs={0}
							disabled={running}
							label={t("Loop length")}
							onCommit={(ms) => setCycleMs(Math.min(RENDER_MAX_HOLD_MS, ms))}
						/>
					</div>
				)}
				<div className="hint">
					{mode === "play"
						? t("The entrance, this long on screen, then the exit, with the variables as they are now: the selected row of every list.")
						: t("One cycle of what moves on air, from where the entrance is over and without the exit: the file plays on in a loop without a jump. 0 finds the length from the animation's own loops, up to 60 s.")}
					{unsaved ? ` ${t("Unsaved changes are saved first.")}` : ""}
				</div>

				{noBrowser ? (
					<div className="err">
						{t("The server has no Chromium, Chrome or Edge to draw the frames with. Install one, or name it in NOTGT_BROWSER.")}
					</div>
				) : null}
				{needsFfmpeg ? (
					<div className="err">{t("ffmpeg is not installed on the server: only DXV3 can be rendered.")}</div>
				) : null}

				{job ? (
					<div className="ed-render__job" data-render-state={job.state}>
						{job.state === "running" ? (
							<>
								<div className="ed-progress">
									<div className="ed-progress__fill" style={{ width: `${percent}%` }} />
								</div>
								<span className="muted">
									{t("{name}: frame {frames}", { name: job.name, frames: job.frames })}
								</span>
							</>
						) : job.state === "error" ? (
							<div className="err">
								{job.errorCode === "no_loop"
									? t("Nothing repeats on air by itself (no endless animation or looping video): give the loop a length.")
									: t("The render failed: {error}", { error: job.error ?? "" })}
							</div>
						) : job.state === "cancelled" ? (
							<span className="muted">{t("The render was stopped.")}</span>
						) : job.file ? (
							<a
								className="ed-render__file"
								href={`${RENDER_BASE}/files/${encodeURIComponent(job.file)}`}
								download={job.file}
								data-render-file={job.file}
							>
								<Icon name="download" size={14} />
								<span className="truncate">{job.file}</span>
								<span className="muted">{job.bytes ? formatBytes(job.bytes) : ""}</span>
							</a>
						) : null}
						{job.state === "done" && job.mode === "loop" && job.cycleMs > 0 ? (
							<span className="muted" data-render-loop={job.cycleMs}>
								{t("A loop of {seconds} s.", { seconds: (job.cycleMs / 1000).toFixed(2) })}
								{(job.missMs ?? 0) > 500 / job.fps
									? ` ${t("Not every part comes round within it: one that repeats every {period} s is {miss} ms off where the file starts over.", {
											period: ((job.missPeriodMs ?? 0) / 1000).toFixed(2),
											miss: Math.round(job.missMs ?? 0),
										})}`
									: ""}
								{job.exactMs
									? ` ${t("Every part comes round after {seconds} s: that loop length makes an exact loop.", {
											seconds: Number((job.exactMs / 1000).toFixed(2)),
										})}`
									: ""}
							</span>
						) : null}
					</div>
				) : null}
				{error ? <div className="err">{error}</div> : null}
				{job?.state === "done" ? <div className="hint">{t("The file is kept on the server for a day.")}</div> : null}

				<div className="ed-render__actions">
					<button type="button" className="ghost" onClick={() => dialogRef.current?.close()}>
						{t("Close")}
					</button>
					{running ? (
						<button type="button" onClick={() => void stop()} data-render-stop>
							{t("Stop")}
						</button>
					) : (
						<button
							type="button"
							className="primary"
							disabled={!template || blocked || status === null}
							onClick={() => void start()}
							data-render-start
						>
							{t("Render")}
						</button>
					)}
				</div>
			</form>
		</dialog>
	);

	return (
		<>
			<button
				type="button"
				onClick={() => void open()}
				disabled={disabled && !running}
				title={t("Render the animation to a video file with alpha")}
				data-render-open
			>
				<Icon name="video" size={14} />
				{running ? t("Render {percent}%", { percent }) : t("Render")}
			</button>
			{createPortal(dialog, document.body)}
		</>
	);
}
