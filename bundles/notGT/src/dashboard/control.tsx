import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

import type { Out, TitleData, VariableSelection } from "../shared/types";
import {
	absoluteOutUrl,
	appendArrayItem,
	coerce,
	copyText,
	duplicateArrayItem,
	flattenData,
	formatMs,
	getTemplate,
	hideTitle,
	makeArray,
	mergeData,
	moveArrayItem,
	removeArrayItem,
	removeDataValue,
	replaceData,
	setArrayItem,
	setByPath,
	setDataValue,
	setSelection,
	showTitle,
	toggleTitle,
	triggerItem,
	triggerTemplate,
	updateItem,
	useActiveTitle,
	useOuts,
	useRuntime,
	useSelection,
	useTemplates,
	useTitleData,
} from "./shared";

function Badge({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone?: "live" | "ok" | "loop";
}) {
	const cls = tone ? `badge badge--${tone}` : "badge";
	return <span className={cls}>{children}</span>;
}

// ------------------------------------------------------------------- helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value) ?? "";
	return String(value);
}

function truncate(text: string, max = 56): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** One-line preview of a value, used in the list and element headers. */
function summarize(value: unknown): string {
	if (value === null || value === undefined) return "— пусто —";
	if (Array.isArray(value)) return `[${value.length}]`;
	if (typeof value === "object") {
		const text = JSON.stringify(value);
		return text && text !== "{}" ? truncate(text) : "{}";
	}
	const text = String(value);
	return text === "" ? "— пусто —" : truncate(text);
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
	dataArray,
	dataIndex,
	dataLeaf,
	dataPath,
	placeholder,
}: {
	value: unknown;
	onCommit: (raw: string) => void;
	className?: string;
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

// ------------------------------------------------------------------ program

function ProgramCard() {
	const templates = useTemplates();
	const outs = useOuts();
	const active = useActiveTitle();

	const [templateId, setTemplateId] = useState<string>("");
	const [outId, setOutId] = useState<string>("");
	const [overrideJson, setOverrideJson] = useState<string>("");
	const [overrideError, setOverrideError] = useState<string>("");

	useEffect(() => {
		if (!templateId && templates.length > 0) setTemplateId(templates[0]!.id);
		if (templateId && !templates.some((t) => t.id === templateId)) {
			setTemplateId(templates[0]?.id ?? "");
		}
	}, [templates, templateId]);

	function overrideData(): TitleData | undefined {
		const trimmed = overrideJson.trim();
		if (!trimmed) return undefined;
		try {
			const parsed = JSON.parse(trimmed) as TitleData;
			setOverrideError("");
			return parsed;
		} catch (error) {
			setOverrideError(String(error));
			return undefined;
		}
	}

	const target = { outId: outId || null, data: overrideData() };

	return (
		<div className="card">
			<div className="card__head">
				<h2>Программа</h2>
				{active.visible ? (
					<Badge tone="live">В эфире: {getTemplate(active.templateId)?.name ?? active.templateId}</Badge>
				) : (
					<Badge>скрыто</Badge>
				)}
			</div>

			<div className="col">
				<label className="field">
					Титр / анимация
					<select
						value={templateId}
						onChange={(event) => setTemplateId(event.target.value)}
					>
						{templates.length === 0 && <option value="">— нет шаблонов —</option>}
						{templates.map((template) => (
							<option key={template.id} value={template.id}>
								{template.name} ({template.kind})
							</option>
						))}
					</select>
				</label>

				<label className="field">
					Out
					<select value={outId} onChange={(event) => setOutId(event.target.value)}>
						<option value="">все out'ы</option>
						{outs.map((out) => (
							<option key={out.id} value={out.id}>
								{out.name} ({out.id})
							</option>
						))}
					</select>
				</label>

				<div className="row">
					<button
						className="primary"
						disabled={!templateId}
						onClick={() => templateId && showTitle(templateId, target)}
					>
						Показать
					</button>
					<button disabled={!templateId} onClick={() => hideTitle({ outId: outId || undefined })}>
						Скрыть
					</button>
					<button
						disabled={!templateId}
						onClick={() => templateId && toggleTitle(templateId, target)}
					>
						Переключить
					</button>
					<button
						disabled={!templateId}
						onClick={() => templateId && triggerTemplate(templateId, outId || null)}
					>
						Проиграть один раз
					</button>
				</div>

				<label className="field">
					Overrides для показа (JSON, необязательно)
					<textarea
						className="code-area"
						style={{ minHeight: 60 }}
						placeholder='{"speaker":{"name":"Гость"}}'
						value={overrideJson}
						onChange={(event) => setOverrideJson(event.target.value)}
					/>
				</label>
				{overrideError && <div className="err">{overrideError}</div>}
				<div className="hint">
					Overrides действуют только на текущий показ и не меняют постоянные значения.
				</div>
				<div className="hint">
					Переменная-список: <code className="mono">{"{{speakers.name}}"}</code> подставляет
					выбранный элемент (см. «Данные (переменные)»).
				</div>
			</div>
		</div>
	);
}

// -------------------------------------------------------------------- data

function DataEmptyState() {
	return (
		<div className="ctl-empty">
			<h3>Выберите переменную слева</h3>
			<p className="hint">
				Переменная может быть одним значением или <strong>списком</strong>. Список — это «выбери
				одного»: на экран попадает только выбранный элемент, а переключение происходит сразу, без
				перезагрузки графики.
			</p>
			<p className="hint">
				Пример: <code className="mono">speakers</code> = список из{" "}
				<code className="mono">{`[{"name":"A","role":"rA"},{"name":"B","role":"rB"}]`}</code>, и{" "}
				<code className="mono">{"{{speakers.name}}"}</code> показывает выбранного.
			</p>
			<p className="hint">
				Обычное значение можно превратить в список кнопкой «сделать списком», затем добавить
				варианты и выбрать активный.
			</p>
		</div>
	);
}

function ScalarEditor({ path, value }: { path: string; value: unknown }) {
	return (
		<div className="ctl-editor">
			<div className="ctl-editor__head">
				<span className="mono ctl-editor__path">{path}</span>
				<Badge>значение</Badge>
			</div>
			<label className="field">
				Значение
				<CommitInput
					className="ctl-scalar-input"
					dataPath={path}
					value={value}
					onCommit={(raw) => setDataValue(path, coerce(raw))}
				/>
			</label>
			<div className="row">
				<button className="ctl-make-array" onClick={() => makeArray(path)}>
					сделать списком
				</button>
				<span className="hint">
					Создаст список из одного элемента — дальше можно добавлять варианты и выбирать
					активный.
				</span>
			</div>
		</div>
	);
}

function ArrayElement({
	path,
	index,
	element,
	count,
	current,
}: {
	path: string;
	index: number;
	element: unknown;
	count: number;
	current: boolean;
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

	return (
		<div
			className={`item ctl-element${current ? " ctl-element--current item--selected" : ""}`}
			data-array={path}
			data-index={index}
		>
			<div className="row ctl-element__head">
				<label className="ctl-current" title="этот элемент идёт в эфир">
					<input
						type="radio"
						name={`ctl-sel-${path}`}
						className="ctl-current__input"
						checked={current}
						data-array={path}
						data-index={index}
						onChange={() => setSelection(path, index)}
					/>
					<span>{current ? "текущий" : "сделать текущим"}</span>
				</label>
				<span className="hint mono">#{index + 1}</span>
				<span className="spacer" />
				<button
					className="tiny"
					title="выше"
					disabled={index === 0}
					onClick={() => moveArrayItem(path, index, -1)}
				>
					↑
				</button>
				<button
					className="tiny"
					title="ниже"
					disabled={index >= count - 1}
					onClick={() => moveArrayItem(path, index, 1)}
				>
					↓
				</button>
				<button
					className="tiny"
					title="дублировать"
					onClick={() => duplicateArrayItem(path, index)}
				>
					⧉
				</button>
				<button
					className="tiny danger"
					title="удалить элемент"
					onClick={() => removeArrayItem(path, index)}
				>
					×
				</button>
			</div>

			{leaves.length > 0 ? (
				<div className="col ctl-leaves">
					{leaves.map((leaf) => (
						<label className="ctl-leaf" key={leaf.path}>
							<span className="ctl-leaf__key mono">{leaf.path}</span>
							<CommitInput
								className="ctl-leaf__input"
								dataArray={path}
								dataIndex={index}
								dataLeaf={leaf.path}
								value={leaf.value}
								onCommit={(raw) => commitLeaf(leaf.path, raw)}
							/>
						</label>
					))}
				</div>
			) : (
				<CommitInput
					className="ctl-leaf__input"
					dataArray={path}
					dataIndex={index}
					dataLeaf=""
					value={element}
					onCommit={(raw) => setArrayItem(path, index, coerce(raw))}
				/>
			)}
		</div>
	);
}

function ArrayEditor({
	path,
	list,
	selection,
}: {
	path: string;
	list: unknown[];
	selection: VariableSelection;
}) {
	const current = chosenIndex(list.length, selection[path]);

	return (
		<div className="ctl-editor">
			<div className="ctl-editor__head">
				<span className="mono ctl-editor__path">{path}</span>
				<Badge tone="ok">список · {list.length}</Badge>
				<span className="spacer" />
				<button className="primary ctl-add" onClick={() => appendArrayItem(path)}>
					＋ добавить значение
				</button>
			</div>
			<div className="hint">
				{"{{" + path + ".поле}}"} подставляет выбранный элемент — сейчас выбран #{" "}
				{list.length === 0 ? "—" : current + 1} из {list.length}.
			</div>

			<div className="col ctl-elements">
				{list.length === 0 && (
					<div className="hint">Список пуст — добавьте значение кнопкой выше.</div>
				)}
				{list.map((element, index) => (
					<ArrayElement
						key={`${path}:${index}`}
						path={path}
						index={index}
						element={element}
						count={list.length}
						current={index === current}
					/>
				))}
			</div>
		</div>
	);
}

function DataCard() {
	const data = useTitleData();
	const selection = useSelection();
	const rows = useMemo(() => flattenData(data), [data]);
	const [selectedPath, setSelectedPath] = useState<string>("");
	const [newPath, setNewPath] = useState("");
	const [newValue, setNewValue] = useState("");
	const [bulk, setBulk] = useState("");
	const [bulkMessage, setBulkMessage] = useState("");

	const selectedRow = rows.find((row) => row.path === selectedPath) ?? null;

	return (
		<div className="card ctl-data-card">
			<div className="card__head">
				<h2>Данные (переменные)</h2>
				<span className="hint">{rows.length} шт.</span>
			</div>

			<div className="ctl-data">
				{/* ------------------------------------------------ left: variable list */}
				<div className="ctl-data__pane ctl-data__list-pane">
					<div className="list ctl-data__list">
						{rows.length === 0 && (
							<div className="hint">
								Нет переменных. Добавьте, например,{" "}
								<code className="mono">speaker.name</code>.
							</div>
						)}
						{rows.map((row) => {
							const list = Array.isArray(row.value) ? row.value : null;
							const chosen = list
								? list[chosenIndex(list.length, selection[row.path])]
								: row.value;
							return (
								<div className="row ctl-var-row" key={row.path}>
									<button
										type="button"
										className={`ctl-var${row.path === selectedPath ? " ctl-var--selected" : ""}`}
										data-path={row.path}
										title={row.path}
										onClick={() => setSelectedPath(row.path)}
									>
										<span className="ctl-var__meta">
											<span className="ctl-var__path mono small">{row.path}</span>
											<span className="ctl-var__summary" title={summarize(chosen)}>
												{summarize(chosen)}
											</span>
										</span>
										<span className="spacer" />
										{list ? (
											<Badge tone="ok">список · {list.length}</Badge>
										) : (
											<Badge>значение</Badge>
										)}
									</button>
									<button
										className="danger tiny ctl-var-delete"
										title="удалить переменную"
										onClick={() => removeDataValue(row.path)}
									>
										×
									</button>
								</div>
							);
						})}
					</div>

					<div className="divider" />

					<div className="row">
						<input
							placeholder="путь, напр. speaker.role"
							value={newPath}
							onChange={(event) => setNewPath(event.target.value)}
							style={{ maxWidth: 180 }}
						/>
						<input
							placeholder="значение"
							value={newValue}
							onChange={(event) => setNewValue(event.target.value)}
						/>
						<button
							className="ctl-add-var"
							onClick={() => {
								if (!newPath.trim()) return;
								setDataValue(newPath.trim(), coerce(newValue));
								setNewPath("");
								setNewValue("");
							}}
						>
							Добавить
						</button>
					</div>

					<div className="divider" />

					<label className="field">
						Массовое обновление (JSON)
						<textarea
							className="code-area"
							style={{ minHeight: 80 }}
							placeholder='{"speaker":{"name":"Иван","role":"Ведущий"}}'
							value={bulk}
							onChange={(event) => setBulk(event.target.value)}
						/>
					</label>
					<div className="row">
						<button
							onClick={() => {
								try {
									mergeData(JSON.parse(bulk || "{}") as TitleData);
									setBulkMessage("Объединено");
								} catch (error) {
									setBulkMessage(`Ошибка: ${String(error)}`);
								}
							}}
						>
							Объединить
						</button>
						<button
							onClick={() => {
								try {
									replaceData(JSON.parse(bulk || "{}") as TitleData);
									setBulkMessage("Заменено");
								} catch (error) {
									setBulkMessage(`Ошибка: ${String(error)}`);
								}
							}}
						>
							Заменить всё
						</button>
						{bulkMessage && <span className="hint">{bulkMessage}</span>}
					</div>
				</div>

				{/* ------------------------------------------------ right: value editor */}
				<div className="ctl-data__pane ctl-data__editor-pane">
					{selectedRow ? (
						Array.isArray(selectedRow.value) ? (
							<ArrayEditor
								path={selectedRow.path}
								list={selectedRow.value}
								selection={selection}
							/>
						) : (
							<ScalarEditor path={selectedRow.path} value={selectedRow.value} />
						)
					) : (
						<DataEmptyState />
					)}
				</div>
			</div>
		</div>
	);
}

// ----------------------------------------------------------------- triggers

function TriggersCard() {
	const outs = useOuts();
	const templates = useTemplates();
	const runtime = useRuntime();

	return (
		<div className="card">
			<div className="card__head">
				<h2>Анимации на out'ах</h2>
				<span className="hint">revision {runtime.revision ?? 0}</span>
			</div>

			{outs.length === 0 && <div className="hint">Out'ы ещё не созданы.</div>}

			{outs.map((out: Out) => (
				<div key={out.id} style={{ marginBottom: 8 }}>
					<div className="row row--between">
						<strong>{out.name}</strong>
						<span className="hint mono">
							{out.id} · {out.width}×{out.height}
						</span>
					</div>
					<div className="list" style={{ marginTop: 4 }}>
						{out.items.length === 0 && <div className="hint">Нет анимаций на этом out.</div>}
						{out.items.map((item) => {
							const template = templates.find((t) => t.id === item.templateId);
							const playing = (runtime.playing?.[out.id] ?? []).includes(item.id);
							return (
								<div className="item" key={item.id}>
									<span className="grow">{template?.name ?? item.templateId}</span>
									{item.playback.mode === "loop" ? (
										<Badge tone="loop">
											loop · {formatMs(item.playback.intervalMs)}
										</Badge>
									) : (
										<Badge>once</Badge>
									)}
									{playing && <Badge tone="ok">играет</Badge>}
									{!item.enabled && <Badge>выкл</Badge>}
									<label
										className={`ctl-switch${item.enabled ? " ctl-switch--on" : ""}`}
										data-out={out.id}
										data-item={item.id}
										data-enabled={item.enabled ? "true" : "false"}
										title={item.enabled ? "показ включён" : "показ выключен"}
									>
										<input
											type="checkbox"
											className="ctl-switch__input"
											checked={item.enabled}
											onChange={() =>
												updateItem(out.id, item.id, { enabled: !item.enabled })
											}
										/>
										<span className="ctl-switch__track">
											<span className="ctl-switch__thumb" />
										</span>
										<span className="ctl-switch__label">показ</span>
									</label>
									<button
										className="tiny ctl-play"
										onClick={() => triggerItem(out.id, item.id)}
									>
										Проиграть
									</button>
								</div>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}

// -------------------------------------------------------------------- outs

function OutsCard() {
	const outs = useOuts();
	const [copied, setCopied] = useState("");
	return (
		<div className="card">
			<div className="card__head">
				<h2>Out'ы для OBS</h2>
			</div>
			<div className="list">
				{outs.map((out) => {
					const url = absoluteOutUrl(out.id);
					return (
						<div className="col" key={out.id} style={{ gap: 2 }}>
							<span className="small">{out.name}</span>
							<div className="out-link">
								<input readOnly value={url} onFocus={(event) => event.target.select()} />
								<button
									className="tiny"
									onClick={() => {
										void copyText(url).then(() => {
											setCopied(out.id);
											window.setTimeout(() => setCopied(""), 1500);
										});
									}}
								>
									{copied === out.id ? "скопировано" : "копировать"}
								</button>
							</div>
						</div>
					);
				})}
				{outs.length === 0 && <div className="hint">Создайте out в панели «Titles &amp; Outs».</div>}
			</div>
		</div>
	);
}

// ------------------------------------------------------------------ status

function StateLine() {
	const active = useActiveTitle();
	const runtime = useRuntime();
	const selection = useSelection();
	const activeName = getTemplate(active.templateId)?.name ?? active.templateId;
	const chosenLists = Object.keys(selection).length;

	return (
		<div className="ctl-status">
			{/* The workspace tab already shows the panel name; keep only a compact brand. */}
			<span className="ctl-status__brand">notGT — Control</span>
			{active.visible ? (
				<Badge tone="live">В эфире: {activeName ?? "—"}</Badge>
			) : (
				<Badge>скрыто</Badge>
			)}
			<span className="hint mono">
				active: {active.templateId ?? "—"} · rev {runtime.revision ?? 0}
			</span>
			{chosenLists > 0 && <span className="hint">списков с выбором: {chosenLists}</span>}
		</div>
	);
}

function App() {
	return (
		<div className="ctl-app">
			<StateLine />
			<div className="ctl-layout">
				<div className="ctl-col">
					<ProgramCard />
					<TriggersCard />
					<OutsCard />
				</div>
				<div className="ctl-col">
					<DataCard />
				</div>
			</div>
		</div>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
