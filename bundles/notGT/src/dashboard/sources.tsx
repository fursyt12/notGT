/**
 * notGT dashboard — Excel workbooks as list variables.
 *
 * A workbook is connected in one of two ways: loaded from the operator's
 * machine (the server keeps a working copy), or tracked where it lies on the
 * server. From then on its sheets are ordinary lists in the Data panel, and
 * the extension keeps the two in step (`src/extension/sources.ts`). This file
 * is the little that the panel adds: the form, the drop, and the list of what
 * is connected.
 */
import { useRef, useState } from "react";

import { BUNDLE_NAME, type DataSource, type DataSourceMode } from "../shared/types";
import { N_, t, type Phrase } from "./i18n";
import { Icon, Menu, Segmented, type MenuItem } from "./ui";

const SOURCES_BASE = `/bundles/${BUNDLE_NAME}/sources`;

interface Failure {
	error?: string;
	message?: string;
	conflicts?: string[];
}

/** What the server refused with, in the operator's words. */
function explain(failure: Failure): string {
	switch (failure.error) {
		case "not_xlsx":
			return t("Only .xlsx workbooks are read. Save the file as .xlsx and try again.");
		case "no_tables":
			return t("No table found: the first filled row of a sheet must hold the column names.");
		case "unreadable":
			return t("The file could not be read as a workbook.");
		case "missing":
			return t("There is no such file on the server.");
		default:
			return t("Could not connect the workbook: {error}", {
				error: failure.message ?? failure.error ?? "?",
			});
	}
}

/**
 * Sends a connect request. When the workbook would replace variables that
 * already exist, the operator is asked, and on a yes the request is repeated
 * with the go-ahead. Resolves to an error text, or to `null` when it worked or
 * was called off.
 */
async function connect(send: (replace: boolean) => Promise<Response>): Promise<string | null> {
	try {
		let response = await send(false);
		let body = (await response.json().catch(() => ({}))) as Failure;
		if (response.status === 409 && body.conflicts?.length) {
			const go = window.confirm(
				t("This will replace what already exists: {list}. Continue?", {
					list: body.conflicts.join(", "),
				}),
			);
			if (!go) return null;
			response = await send(true);
			body = (await response.json().catch(() => ({}))) as Failure;
		}
		return response.ok ? null : explain(body);
	} catch (error) {
		return explain({ message: String((error as Error)?.message ?? error) });
	}
}

export function isWorkbook(file: File): boolean {
	return /\.xlsx$/i.test(file.name);
}

/** Load: the file's bytes go to the server, which keeps a working copy. */
export function loadWorkbook(file: File): Promise<string | null> {
	if (!isWorkbook(file)) return Promise.resolve(explain({ error: "not_xlsx" }));
	return connect((replace) =>
		fetch(
			`${SOURCES_BASE}/upload?name=${encodeURIComponent(file.name)}${replace ? "&replace=1" : ""}`,
			{ method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
		),
	);
}

/** Track: the file stays where it is on the server. */
export function trackWorkbook(path: string): Promise<string | null> {
	return connect((replace) =>
		fetch(`${SOURCES_BASE}/track`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path, replace }),
		}),
	);
}

/** The sheet each mirrored variable belongs to. */
export function boundVariables(
	sources: DataSource[],
): Map<string, { source: DataSource; sheet: string }> {
	const bound = new Map<string, { source: DataSource; sheet: string }>();
	for (const source of sources) {
		for (const mapped of source.sheets) bound.set(mapped.variable, { source, sheet: mapped.sheet });
	}
	return bound;
}

const MODES: Array<{ value: DataSourceMode; label: Phrase }> = [
	{ value: "load", label: N_("Load a file") },
	{ value: "track", label: N_("Track a file on the server") },
];

/** The form that connects a workbook, in either mode. */
export function ExcelTool({
	busy,
	error,
	onLoad,
	onTrack,
}: {
	busy: boolean;
	error: string;
	onLoad: (file: File) => void;
	onTrack: (path: string) => void;
}) {
	const [mode, setMode] = useState<DataSourceMode>("load");
	const [path, setPath] = useState("");
	const fileRef = useRef<HTMLInputElement | null>(null);

	return (
		<div className="ctl-tool ctl-tool--col ctl-excel">
			<Segmented
				value={mode}
				options={MODES.map((item) => ({ value: item.value, label: t(item.label) }))}
				onChange={setMode}
				label={t("How the workbook is connected")}
			/>

			{mode === "load" ? (
				<>
					<div className="ctl-excel__row">
						<input
							ref={fileRef}
							type="file"
							accept=".xlsx"
							hidden
							data-excel-file
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) onLoad(file);
								event.target.value = "";
							}}
						/>
						<button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
							<Icon name="table" size={14} />
							{busy ? t("Connecting…") : t("Choose a workbook…")}
						</button>
					</div>
					<p className="hint">
						{t(
							"Or drop an .xlsx anywhere on this panel. Every sheet becomes a list: its first row names the columns. notGT keeps a working copy, writes your edits into it, and gives it back with “Download the workbook”.",
						)}
					</p>
				</>
			) : (
				<>
					<form
						className="ctl-excel__row"
						onSubmit={(event) => {
							event.preventDefault();
							if (path.trim()) onTrack(path.trim());
						}}
					>
						<input
							autoFocus
							className="mono ctl-excel__path"
							aria-label={t("Path of the workbook on the server")}
							placeholder="/data/titles.xlsx"
							value={path}
							data-excel-path
							onChange={(event) => setPath(event.target.value)}
						/>
						<button type="submit" className="primary" disabled={busy || !path.trim()}>
							{busy ? t("Connecting…") : t("Track")}
						</button>
					</form>
					<p className="hint">
						{t(
							"The path is on the machine notGT runs on. The file is read again whenever it is saved there, and your edits here are written into it.",
						)}
					</p>
				</>
			)}

			{error ? (
				<p className="err" role="alert" data-excel-error>
					{error}
				</p>
			) : null}
		</div>
	);
}

/** Why a workbook is out of step, in the operator's words. */
function problemText(source: DataSource): string {
	switch (source.problem) {
		case "missing":
			return t("The file is not where it was.");
		case "locked":
			return t(
				"The file cannot be written: it is open in a spreadsheet or read-only. Close it there, then change a value again.",
			);
		case "unreadable":
			return t("The file can no longer be read as a workbook.");
		default:
			return source.detail ?? "";
	}
}

function SourceRow({ source }: { source: DataSource }) {
	const menu: MenuItem[] = [
		{
			label: t("Download the workbook"),
			icon: "down",
			onSelect: () => window.location.assign(`${SOURCES_BASE}/${source.id}/download`),
		},
		{
			label: t("Read the file again"),
			icon: "copy",
			onSelect: () => void fetch(`${SOURCES_BASE}/${source.id}/reload`, { method: "POST" }),
		},
		{
			label: t("Disconnect"),
			hint: t("The lists stay, as ordinary variables"),
			icon: "x",
			separated: true,
			onSelect: () => void fetch(`${SOURCES_BASE}/${source.id}`, { method: "DELETE" }),
		},
	];

	return (
		<div
			className={`ctl-source${source.state === "error" ? " is-error" : ""}`}
			data-source={source.name}
			data-source-mode={source.mode}
		>
			<div className="ctl-source__line">
				<Icon name="table" size={14} />
				<span
					className="ctl-source__name truncate"
					title={source.mode === "track" ? source.path : source.name}
				>
					{source.name}
				</span>
				<span className="tag">{source.mode === "track" ? t("tracked") : t("loaded")}</span>
				<span className="ctl-source__lists mono muted truncate">
					{source.sheets.map((mapped) => mapped.variable).join(", ")}
				</span>
				<span className="spacer" />
				<Menu items={menu} label={t("Actions: {name}", { name: source.name })} />
			</div>
			{source.state === "error" ? (
				<p className="err" role="alert">
					{problemText(source)}
				</p>
			) : null}
		</div>
	);
}

/** The workbooks that are connected right now. */
export function SourceList({ sources }: { sources: DataSource[] }) {
	if (sources.length === 0) return null;
	return (
		<div className="ctl-sources" aria-label={t("Workbooks")}>
			{sources.map((source) => (
				<SourceRow key={source.id} source={source} />
			))}
		</div>
	);
}
