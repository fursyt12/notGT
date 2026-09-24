import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

import { coerce, flattenData } from "../shared/binding";
import type { Out, TitleData } from "../shared/types";
import {
	absoluteOutUrl,
	copyText,
	formatMs,
	getTemplate,
	hideTitle,
	mergeData,
	removeDataValue,
	replaceData,
	setDataValue,
	showTitle,
	toggleTitle,
	triggerItem,
	triggerTemplate,
	useActiveTitle,
	useOuts,
	useRuntime,
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
			</div>
		</div>
	);
}

function DataCard() {
	const data = useTitleData();
	const rows = useMemo(() => flattenData(data), [data]);
	const [newPath, setNewPath] = useState("");
	const [newValue, setNewValue] = useState("");
	const [bulk, setBulk] = useState("");
	const [bulkMessage, setBulkMessage] = useState("");

	return (
		<div className="card">
			<div className="card__head">
				<h2>Данные (переменные)</h2>
				<span className="hint">{rows.length} шт.</span>
			</div>

			<div className="list">
				{rows.length === 0 && (
					<div className="hint">
						Нет переменных. Добавьте, например, <code className="mono">speaker.name</code>.
					</div>
				)}
				{rows.map((row) => (
					<div className="item" key={row.path}>
						<span className="mono small grow" title={row.path}>
							{row.path}
						</span>
						<input
							key={row.path}
							defaultValue={
								typeof row.value === "object"
									? JSON.stringify(row.value)
									: String(row.value ?? "")
							}
							onChange={(event) => setDataValue(row.path, coerce(event.target.value))}
							style={{ maxWidth: 200 }}
						/>
						<button className="danger tiny" onClick={() => removeDataValue(row.path)}>
							×
						</button>
					</div>
				))}
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
	);
}

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
									<button className="tiny" onClick={() => triggerItem(out.id, item.id)}>
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

function StateLine() {
	const active = useActiveTitle();
	const runtime = useRuntime();
	return (
		<div className="row row--between" style={{ marginBottom: 8 }}>
			<h1>notGT — Control</h1>
			<span className="hint mono">
				active: {active.templateId ?? "—"} {active.visible ? "visible" : "hidden"} · rev{" "}
				{runtime.revision ?? 0}
			</span>
		</div>
	);
}

function App() {
	return (
		<>
			<StateLine />
			<ProgramCard />
			<DataCard />
			<TriggersCard />
			<OutsCard />
		</>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
