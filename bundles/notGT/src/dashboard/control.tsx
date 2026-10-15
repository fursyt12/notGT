/**
 * notGT — Control dashboard panel (fullbleed): live operation only.
 *
 * Left: what is placed on each out, one row per placement, with the two things
 * an operator does on air — play it once, or switch it on and keep it there.
 * Under them: the timers those titles can show, started, paused and nudged
 * here. Right: the variables those titles read. Nothing here changes a
 * layout; that is the Editor's job.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import type {
	DataSource,
	Out,
	OutItem,
	TitleData,
	TitleTemplate,
	VariableSelection,
} from "../shared/types";
import {
	useOutUrl,
	addArrayColumn,
	appendArrayItem,
	coerce,
	duplicateArrayItem,
	flattenData,
	getTemplate,
	hideTitle,
	itemCanPlay,
	makeArray,
	mergeData,
	moveArrayItem,
	removeArrayItem,
	removeDataValue,
	replaceData,
	saveOut,
	setArrayItem,
	setByPath,
	setDataValue,
	setSelection,
	showTitle,
	stopPlayback,
	triggerItem,
	triggerTemplate,
	updateItem,
	updateItemPlayback,
	useActiveTitle,
	useOuts,
	useRuntime,
	useSelection,
	useSources,
	useTemplates,
	useTitleData,
} from "./shared";
import { t, tr, useLang } from "./i18n";
import {
	ExcelTool,
	SourceList,
	boundVariables,
	isWorkbook,
	loadWorkbook,
	trackWorkbook,
} from "./sources";
import { TimersPanel } from "./timers";
import {
	CopyButton,
	Disclosure,
	Icon,
	LangSwitch,
	ThemeSwitch,
	Menu,
	PlaybackFields,
	Switch,
	playbackSummary,
	type MenuItem,
} from "./ui";

// ------------------------------------------------------------------- helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value) ?? "";
	return String(value);
}

/** Keeps a stored selection index inside the array bounds (selection may be stale). */
function chosenIndex(length: number, raw: number | undefined): number {
	if (length <= 0) return 0;
	const index = raw ?? 0;
	return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Text input that commits every keystroke but keeps a local draft while focused,
 * so the asynchronous Replicant echo cannot clobber the caret mid-typing.
 */
function CommitInput({
	value,
	onCommit,
	className,
	label,
	dataArray,
	dataIndex,
	dataLeaf,
	dataPath,
	placeholder,
}: {
	value: unknown;
	onCommit: (raw: string) => void;
	className?: string;
	label: string;
	dataArray?: string;
	dataIndex?: number;
	dataLeaf?: string;
	dataPath?: string;
	placeholder?: string;
}) {
	const external = scalarText(value);
	const [draft, setDraft] = useState(external);
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(external);
	}, [external, focused]);

	return (
		<input
			className={className}
			aria-label={label}
			data-array={dataArray}
			data-index={dataIndex}
			data-leaf={dataLeaf}
			data-path={dataPath}
			placeholder={placeholder}
			value={draft}
			onFocus={() => setFocused(true)}
			onBlur={() => {
				setFocused(false);
				setDraft(external);
			}}
			onChange={(event) => {
				setDraft(event.target.value);
				onCommit(event.target.value);
			}}
		/>
	);
}

// ------------------------------------------------------------------- on air

/** Names of everything that is on air right now, across all outs. */
function useOnAir(): string[] {
	const outs = useOuts();
	const templates = useTemplates();
	const runtime = useRuntime();
	const active = useActiveTitle();

	return useMemo(() => {
		const names = new Set<string>();
		const nameOf = (templateId: string) =>
			templates.find((template) => template.id === templateId)?.name ?? templateId;
		for (const out of outs) {
			for (const itemId of runtime.playing?.[out.id] ?? []) {
				const item = out.items.find((candidate) => candidate.id === itemId);
				if (item) names.add(nameOf(item.templateId));
			}
		}
		if (active.visible && active.templateId) names.add(nameOf(active.templateId));
		return [...names];
	}, [outs, templates, runtime, active]);
}

/**
 * Empties the air on every out: switches off the held placements, hides the
 * manually shown animation and drops the one-shots that are still playing.
 */
function clearAir(outs: Out[]): void {
	hideTitle();
	for (const out of outs) {
		if (!out.items.some((item) => item.held)) continue;
		saveOut({
			...out,
			items: out.items.map((item) => (item.held ? { ...item, held: false } : item)),
		});
	}
	stopPlayback();
}

function AirBar() {
	const outs = useOuts();
	const onAir = useOnAir();
	const live = onAir.length > 0;

	return (
		<header className={`ctl-bar${live ? " is-live" : ""}`}>
			<span className={`tally${live ? " is-live" : ""}`} aria-hidden="true" />
			<span className="ctl-bar__text truncate" role="status">
				{live ? t("On air: {names}", { names: onAir.join(", ") }) : t("Nothing is on air")}
			</span>
			<span className="spacer" />
			<button
				type="button"
				disabled={!live}
				title={t("Clears every out at once: turns off the “On air” switches, stops what is playing and hides the animation shown by hand.")}
				onClick={() => clearAir(outs)}
			>
				{t("Take everything off air")}
			</button>
			<ThemeSwitch />
			<LangSwitch />
		</header>
	);
}

// ---------------------------------------------------------------- placements

function CueRow({
	out,
	item,
	template,
	playing,
}: {
	out: Out;
	item: OutItem;
	template: TitleTemplate | undefined;
	playing: boolean;
}) {
	const [open, setOpen] = useState(false);
	const canPlay = itemCanPlay(item, template);
	const name = template?.name ?? item.templateId;

	return (
		<div className={`cue${playing ? " is-live" : ""}`} data-out={out.id} data-item={item.id}>
			<div className="cue__main">
				<span className={`tally${playing ? " is-live" : ""}`} aria-hidden="true" />
				<div className="cue__title">
					<span className="cue__name truncate" title={name}>
						{name}
					</span>
					<button
						type="button"
						className="cue__meta"
						aria-expanded={open}
						title={t("Playback settings")}
						onClick={() => setOpen((value) => !value)}
					>
						{playbackSummary(item, template)}
						<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
					</button>
				</div>
				{!item.enabled && !item.held ? (
					<span
						className="tag"
						title={t("Does not start by animation name from the API or Companion. Turn it on in Editor, on the “Placement” tab.")}
					>
						{t("API start is off")}
					</span>
				) : null}
				{/* A loop and a held title have no one-shot: the switch is their only control. */}
				{canPlay ? (
					<button
						type="button"
						className="ctl-play"
						data-can-play="true"
						title={t("Play once")}
						onClick={() => triggerItem(out.id, item.id)}
					>
						<Icon name="play" size={14} />
						{t("Play")}
					</button>
				) : null}
				<Switch
					className="ctl-switch"
					live
					label={t("On air")}
					title={item.held ? t("Take off air") : t("Show and keep on air")}
					checked={Boolean(item.held)}
					data-out={out.id}
					data-item={item.id}
					data-held={item.held ? "true" : "false"}
					onChange={() => updateItem(out.id, item.id, { held: !item.held })}
				/>
			</div>
			{open ? (
				<div className="cue__settings">
					<PlaybackFields
						playback={item.playback}
						template={template}
						scope="item"
						onChange={(patch) => updateItemPlayback(out.id, item.id, patch)}
					/>
				</div>
			) : null}
		</div>
	);
}

function OutBlock({ out }: { out: Out }) {
	const templates = useTemplates();
	const runtime = useRuntime();
	const playing = runtime.playing?.[out.id] ?? [];
	const items = [...out.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

	return (
		<section className="panel ctl-out">
			<header className="panel__head">
				<h2 className="truncate">{out.name}</h2>
				<span className="hint">
					{out.width}×{out.height}
				</span>
				<span className="spacer" />
				<CopyButton text={useOutUrl(out.id)} label={t("Link for OBS")} />
			</header>
			{items.length === 0 ? (
				<div className="empty">
					{t("Nothing on this out yet. Place an animation in Editor or in Titles & Outs.")}
				</div>
			) : (
				items.map((item) => (
					<CueRow
						key={item.id}
						out={out}
						item={item}
						template={templates.find((template) => template.id === item.templateId)}
						playing={playing.includes(item.id)}
					/>
				))
			)}
		</section>
	);
}

/**
 * Shows any animation without placing it first — the same manual "program"
 * the REST API and Companion drive.
 */
function QuickShow() {
	const templates = useTemplates();
	const outs = useOuts();

	const [templateId, setTemplateId] = useState("");
	const [outId, setOutId] = useState("");
	const [withData, setWithData] = useState(false);
	const [overrideJson, setOverrideJson] = useState("");
	const [overrideError, setOverrideError] = useState("");

	useEffect(() => {
		if (templates.some((template) => template.id === templateId)) return;
		setTemplateId(templates[0]?.id ?? "");
	}, [templates, templateId]);

	/** `undefined` = no override; `null` = the JSON does not parse. */
	function readOverride(): TitleData | undefined | null {
		const trimmed = withData ? overrideJson.trim() : "";
		if (!trimmed) return undefined;
		try {
			const parsed = JSON.parse(trimmed) as TitleData;
			setOverrideError("");
			return parsed;
		} catch (error) {
			setOverrideError(t("This is not JSON: {error}", { error: (error as Error).message }));
			return null;
		}
	}

	return (
		<section className="panel">
			<Disclosure title={t("Show an animation without placing it")} storageKey="notgt.control.quick">
				<div className="ctl-quick">
					<div className="row">
						<label className="field grow">
							{t("Animation")}
							<select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
								{templates.length === 0 ? <option value="">{t("No animations yet")}</option> : null}
								{templates.map((template) => (
									<option key={template.id} value={template.id}>
										{template.name}
									</option>
								))}
							</select>
						</label>
						<label className="field ctl-quick__out">
							Out
							<select value={outId} onChange={(event) => setOutId(event.target.value)}>
								<option value="">{t("All")}</option>
								{outs.map((out) => (
									<option key={out.id} value={out.id}>
										{out.name}
									</option>
								))}
							</select>
						</label>
					</div>

					<div className="row row--wrap">
						<button
							type="button"
							className="primary"
							disabled={!templateId}
							onClick={() => {
								const data = readOverride();
								if (data === null) return;
								showTitle(templateId, { outId: outId || null, data });
							}}
						>
							{t("Show")}
						</button>
						<button
							type="button"
							disabled={!templateId}
							onClick={() => triggerTemplate(templateId, outId || null)}
						>
							{t("Play once")}
						</button>
						<button type="button" onClick={() => hideTitle({ outId: outId || undefined })}>
							{t("Hide")}
						</button>
						<span className="spacer" />
						<label className="check muted">
							<input
								type="checkbox"
								checked={withData}
								onChange={(event) => setWithData(event.target.checked)}
							/>
							{t("Custom data for this show")}
						</label>
					</div>

					{withData ? (
						<>
							<textarea
								className="code-area"
								rows={3}
								aria-label={t("Data for this show only, JSON")}
								placeholder='{"speaker":{"name":"Guest"}}'
								value={overrideJson}
								onChange={(event) => setOverrideJson(event.target.value)}
							/>
							{overrideError ? (
								<div className="err">{overrideError}</div>
							) : (
								<div className="hint">
									{t("Applies to this show only. The variables on the right stay as they are.")}
								</div>
							)}
						</>
					) : null}
				</div>
			</Disclosure>
		</section>
	);
}

// --------------------------------------------------------------------- data

interface VarRow {
	path: string;
	/** The path without its group prefix: `name` for `speaker.name`. */
	label: string;
	value: unknown;
}

/** Groups `speaker.name`, `speaker.role` under `speaker`, in first-seen order. */
function groupRows(rows: Array<{ path: string; value: unknown }>): Array<{ name: string; rows: VarRow[] }> {
	const groups = new Map<string, VarRow[]>();
	for (const row of rows) {
		const dot = row.path.indexOf(".");
		const name = dot > 0 ? row.path.slice(0, dot) : "";
		const label = dot > 0 ? row.path.slice(dot + 1) : row.path;
		const list = groups.get(name) ?? [];
		list.push({ ...row, label });
		groups.set(name, list);
	}
	return [...groups.entries()].map(([name, list]) => ({ name, rows: list }));
}

function ScalarRow({ row }: { row: VarRow }) {
	const menu: MenuItem[] = [
		{
			label: t("Turn into a list"),
			hint: t("Several options; the chosen one goes on air"),
			icon: "list",
			onSelect: () => makeArray(row.path),
		},
		{
			label: t("Delete variable"),
			icon: "trash",
			danger: true,
			separated: true,
			onSelect: () => removeDataValue(row.path),
		},
	];

	return (
		<div className="var ctl-var-row">
			<span className="var__key mono truncate" title={row.path}>
				{row.label}
			</span>
			<CommitInput
				className="ctl-scalar-input"
				label={row.path}
				dataPath={row.path}
				value={row.value}
				onCommit={(raw) => setDataValue(row.path, coerce(raw))}
			/>
			<Menu items={menu} label={t("Actions: {name}", { name: row.path })} />
		</div>
	);
}

/**
 * Columns for a list whose elements are flat objects of a few fields — such a
 * list reads best as a small table. Anything else is edited field by field.
 */
/** A list of records with up to this many fields is shown as a table. */
const MAX_TABLE_COLUMNS = 6;

function tableColumns(list: unknown[]): string[] | null {
	if (list.length === 0 || !list.every(isPlainObject)) return null;
	const columns: string[] = [];
	for (const element of list) {
		for (const leaf of flattenData(element as TitleData)) {
			if (Array.isArray(leaf.value)) return null;
			if (!columns.includes(leaf.path)) columns.push(leaf.path);
		}
	}
	return columns.length > 0 && columns.length <= MAX_TABLE_COLUMNS ? columns : null;
}

function ListRow({
	path,
	index,
	element,
	count,
	current,
	columns,
}: {
	path: string;
	index: number;
	element: unknown;
	count: number;
	current: boolean;
	columns: string[] | null;
}) {
	const leaves = useMemo(
		() => (isPlainObject(element) ? flattenData(element as TitleData) : []),
		[element],
	);

	function commitLeaf(leaf: string, raw: string): void {
		if (!isPlainObject(element)) return;
		const next: Record<string, unknown> = { ...element };
		// `setByPath` so nested leaves (`a.b`) keep working, flat leaves included.
		setByPath(next, leaf, coerce(raw));
		setArrayItem(path, index, next);
	}

	const menu: MenuItem[] = [
		{ label: t("Move up"), icon: "up", disabled: index === 0, onSelect: () => moveArrayItem(path, index, -1) },
		{
			label: t("Move down"),
			icon: "down",
			disabled: index >= count - 1,
			onSelect: () => moveArrayItem(path, index, 1),
		},
		{ label: t("Duplicate"), icon: "copy", onSelect: () => duplicateArrayItem(path, index) },
		{
			label: t("Delete row"),
			icon: "trash",
			danger: true,
			separated: true,
			onSelect: () => removeArrayItem(path, index),
		},
	];

	const leafInput = (leaf: string, value: unknown) => (
		<CommitInput
			key={leaf}
			className="ctl-leaf__input"
			label={`${path} ${index + 1}: ${leaf}`}
			dataArray={path}
			dataIndex={index}
			dataLeaf={leaf}
			value={value}
			onCommit={(raw) => commitLeaf(leaf, raw)}
		/>
	);

	return (
		<div
			className={`vlist__row ctl-element${current ? " is-current ctl-element--current" : ""}`}
			data-array={path}
			data-index={index}
		>
			<input
				type="radio"
				name={`ctl-sel-${path}`}
				className="ctl-current__input"
				aria-label={t("{path}: row {n} goes on air", { path, n: index + 1 })}
				title={current ? t("This row goes on air") : t("Send this row on air")}
				checked={current}
				data-array={path}
				data-index={index}
				onChange={() => setSelection(path, index)}
			/>
			{columns ? (
				<div
					className="vlist__cells"
					style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
				>
					{columns.map((column) =>
						leafInput(column, leaves.find((leaf) => leaf.path === column)?.value),
					)}
				</div>
			) : leaves.length > 0 ? (
				<div className="vlist__stack">
					{leaves.map((leaf) => (
						<label className="vlist__pair" key={leaf.path}>
							<span className="mono muted truncate" title={leaf.path}>
								{leaf.path}
							</span>
							{leafInput(leaf.path, leaf.value)}
						</label>
					))}
				</div>
			) : (
				<CommitInput
					className="ctl-leaf__input"
					label={t("{path}: row {n}", { path, n: index + 1 })}
					dataArray={path}
					dataIndex={index}
					dataLeaf=""
					value={element}
					onCommit={(raw) => setArrayItem(path, index, coerce(raw))}
				/>
			)}
			<Menu items={menu} label={t("Actions: row {n}", { n: index + 1 })} />
		</div>
	);
}

function ListBlock({
	row,
	selection,
	bound,
}: {
	row: VarRow;
	selection: VariableSelection;
	/** The sheet this list mirrors, when it comes from a workbook. */
	bound?: { source: DataSource; sheet: string };
}) {
	const list = row.value as unknown[];
	const current = chosenIndex(list.length, selection[row.path]);
	const columns = useMemo(() => tableColumns(list), [list]);

	const menu: MenuItem[] = [
		{
			label: t("Add a column"),
			icon: "plus",
			onSelect: () => {
				const name = window.prompt(t("Name of the new column"));
				if (name) addArrayColumn(row.path, name);
			},
		},
		{
			label: t("Delete list"),
			icon: "trash",
			danger: true,
			separated: true,
			onSelect: () => removeDataValue(row.path),
		},
	];

	return (
		<div className="vlist" data-path={row.path}>
			<div className="vlist__head">
				<span className="var__key mono truncate" title={row.path}>
					{row.label}
				</span>
				<span className="tag" title={t("{{{path}.field}} inserts the chosen row", { path: row.path })}>
					{t("list")}
				</span>
				{bound ? (
					<span
						className="tag"
						data-excel-tag
						title={t("Mirrors the sheet “{sheet}” of {file}", {
							sheet: bound.sheet,
							file: bound.source.name,
						})}
					>
						Excel
					</span>
				) : null}
				<span className="spacer" />
				<button
					type="button"
					className="ghost small ctl-add"
					onClick={() => appendArrayItem(row.path)}
				>
					<Icon name="plus" size={14} />
					{t("Row")}
				</button>
				<Menu items={menu} label={t("Actions: {name}", { name: row.path })} />
			</div>

			{list.length === 0 ? (
				<div className="hint">{t("The list is empty. Add a row and it becomes the chosen one.")}</div>
			) : null}

			{columns && list.length > 0 ? (
				<div className="vlist__row vlist__row--head" aria-hidden="true">
					<span />
					<div
						className="vlist__cells"
						style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
					>
						{columns.map((column) => (
							<span className="mono truncate" key={column}>
								{column}
							</span>
						))}
					</div>
					<span />
				</div>
			) : null}

			{list.map((element, index) => (
				<ListRow
					key={`${row.path}:${index}`}
					path={row.path}
					index={index}
					element={element}
					count={list.length}
					current={index === current}
					columns={columns}
				/>
			))}
		</div>
	);
}

/**
 * Variables an added path would replace: the path itself, a group it would
 * flatten (`speaker` over `speaker.name`), or a value it would turn into a
 * group (`speaker.name.first` over `speaker.name`).
 */
function overwrittenBy(path: string, rows: Array<{ path: string }>): string[] {
	return rows
		.map((row) => row.path)
		.filter(
			(existing) =>
				existing === path ||
				existing.startsWith(`${path}.`) ||
				path.startsWith(`${existing}.`),
		);
}

function AddVariable({ rows }: { rows: Array<{ path: string }> }) {
	const [path, setPath] = useState("");
	const [value, setValue] = useState("");
	const pathRef = useRef<HTMLInputElement | null>(null);

	return (
		<form
			className="ctl-tool"
			onSubmit={(event) => {
				event.preventDefault();
				const target = path.trim();
				if (!target) return;
				const lost = overwrittenBy(target, rows);
				if (
					lost.length > 0 &&
					!window.confirm(
						t("This will replace what already exists: {list}. Continue?", { list: lost.join(", ") }),
					)
				) {
					return;
				}
				setDataValue(target, coerce(value));
				setPath("");
				setValue("");
				pathRef.current?.focus();
			}}
		>
			<input
				ref={pathRef}
				autoFocus
				className="mono ctl-tool__path"
				aria-label={t("Path of the new variable")}
				placeholder="speaker.role"
				value={path}
				onChange={(event) => setPath(event.target.value)}
			/>
			<input
				aria-label={t("Value of the new variable")}
				placeholder={t("Value")}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			<button type="submit" className="primary ctl-add-var" disabled={!path.trim()}>
				{t("Add")}
			</button>
		</form>
	);
}

function BulkJson() {
	const [text, setText] = useState("");
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

	const apply = (mode: "merge" | "replace") => {
		let parsed: TitleData;
		try {
			parsed = JSON.parse(text || "{}") as TitleData;
		} catch (error) {
			setMessage({
				ok: false,
				text: t("This is not JSON: {error}", { error: (error as Error).message }),
			});
			return;
		}
		if (mode === "replace") {
			if (!window.confirm(t("Replace all variables with the contents of the field? The current values will be lost."))) {
				return;
			}
			replaceData(parsed);
			setMessage({ ok: true, text: t("All variables replaced") });
		} else {
			mergeData(parsed);
			setMessage({ ok: true, text: t("Added to the current ones") });
		}
	};

	return (
		<div className="ctl-tool ctl-tool--col">
			<textarea
				className="code-area"
				rows={5}
				autoFocus
				aria-label={t("Variables as JSON")}
				placeholder='{"speaker":{"name":"John","role":"Host"}}'
				value={text}
				onChange={(event) => setText(event.target.value)}
			/>
			<div className="row row--wrap">
				<button type="button" onClick={() => apply("merge")}>
					{t("Add to current")}
				</button>
				<button type="button" className="danger" onClick={() => apply("replace")}>
					{t("Replace all")}
				</button>
				{message ? <span className={message.ok ? "hint" : "err"}>{message.text}</span> : null}
			</div>
		</div>
	);
}

function DataPanel() {
	const data = useTitleData();
	const selection = useSelection();
	const rows = useMemo(() => flattenData(data), [data]);
	const groups = useMemo(() => groupRows(rows), [rows]);
	const sources = useSources();
	const bound = useMemo(() => boundVariables(sources), [sources]);
	const [tool, setTool] = useState<"add" | "json" | "excel" | null>(null);
	const [excelBusy, setExcelBusy] = useState(false);
	const [excelError, setExcelError] = useState("");
	const [dropping, setDropping] = useState(false);

	const toggle = (next: "add" | "json" | "excel") =>
		setTool((value) => (value === next ? null : next));

	// A failure opens the Excel form, which is where it is explained.
	const connectWorkbook = async (run: () => Promise<string | null>) => {
		setExcelBusy(true);
		setExcelError("");
		const failure = await run();
		setExcelBusy(false);
		if (failure) {
			setExcelError(failure);
			setTool("excel");
		} else {
			setTool((value) => (value === "excel" ? null : value));
		}
	};

	const carriesFiles = (event: DragEvent<HTMLElement>) =>
		Array.from(event.dataTransfer.types).includes("Files");

	return (
		<section
			className={`panel ctl-data${dropping ? " is-dropping" : ""}`}
			onDragOver={(event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				setDropping(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
			}}
			onDrop={(event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				setDropping(false);
				// Dropping is the load mode: the file comes from this machine.
				const file =
					Array.from(event.dataTransfer.files).find(isWorkbook) ?? event.dataTransfer.files[0];
				if (file) void connectWorkbook(() => loadWorkbook(file));
			}}
		>
			{dropping ? (
				<div className="ctl-drop" aria-hidden="true">
					<Icon name="table" size={22} />
					{t("Drop the workbook to load it")}
				</div>
			) : null}
			<header className="panel__head">
				<h2>{t("Data")}</h2>
				<span className="spacer" />
				<button
					type="button"
					className={`ghost${tool === "excel" ? " is-on" : ""}`}
					aria-expanded={tool === "excel"}
					data-excel-toggle
					onClick={() => toggle("excel")}
				>
					<Icon name="table" size={14} />
					Excel
				</button>
				<button
					type="button"
					className={`ghost${tool === "json" ? " is-on" : ""}`}
					aria-expanded={tool === "json"}
					onClick={() => toggle("json")}
				>
					<Icon name="code" size={14} />
					JSON
				</button>
				<button
					type="button"
					className={`ghost${tool === "add" ? " is-on" : ""}`}
					aria-expanded={tool === "add"}
					onClick={() => toggle("add")}
				>
					<Icon name="plus" size={14} />
					{t("Variable")}
				</button>
			</header>

			{tool === "add" ? <AddVariable rows={rows} /> : null}
			{tool === "json" ? <BulkJson /> : null}
			{tool === "excel" ? (
				<ExcelTool
					busy={excelBusy}
					error={excelError}
					onLoad={(file) => void connectWorkbook(() => loadWorkbook(file))}
					onTrack={(path) => void connectWorkbook(() => trackWorkbook(path))}
				/>
			) : null}

			<SourceList sources={sources} />

			{rows.length === 0 ? (
				<div className="empty">
					{tr(
						"No variables yet. Add one, for example {path} — an animation reads it as {token}.",
						{ path: <code>speaker.name</code>, token: <code>{"{{speaker.name}}"}</code> },
					)}
				</div>
			) : (
				groups.map((group) => (
					<div className="vgroup" key={group.name}>
						{group.name ? <h3 className="vgroup__name mono">{group.name}</h3> : null}
						{group.rows.map((row) =>
							Array.isArray(row.value) ? (
								<ListBlock
									key={row.path}
									row={row}
									selection={selection}
									bound={bound.get(row.path)}
								/>
							) : (
								<ScalarRow key={row.path} row={row} />
							),
						)}
					</div>
				))
			)}
		</section>
	);
}

// ---------------------------------------------------------------------- app

function App() {
	const outs = useOuts();
	useLang();

	return (
		<div className="ctl">
			<AirBar />
			<div className="ctl-body">
				<div className="ctl-air">
					{outs.length === 0 ? (
						<section className="panel">
							<div className="empty">
								{t("An out is one Browser Source in OBS. Create the first one in Titles & Outs.")}
							</div>
						</section>
					) : (
						outs.map((out) => <OutBlock key={out.id} out={out} />)
					)}
					<TimersPanel />
					<QuickShow />
				</div>
				<DataPanel />
			</div>
		</div>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
