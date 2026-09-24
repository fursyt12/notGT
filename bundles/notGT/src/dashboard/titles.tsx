import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { collectBindingPaths } from "../shared/binding";
import type { Out, OutItem } from "../shared/types";
import {
	absoluteOutUrl,
	addItem,
	clone,
	copyText,
	createOut,
	deleteOut,
	deleteTemplate,
	duplicateTemplate,
	getTemplate,
	hasVideoLayer,
	moveItem,
	newTemplate,
	removeItem,
	saveOut,
	saveTemplate,
	triggerItem,
	updateItem,
	updateItemPlayback,
	useOuts,
	useRuntime,
	useTemplates,
	useVideoDuration,
	videoHoldHint,
	videoLayerSignature,
} from "./shared";

/** Number input that commits on blur / Enter. */
function NumberInput({
	value,
	onCommit,
	step = 1,
	min,
	max,
	title,
	suffix,
	disabled,
}: {
	value: number | undefined;
	onCommit: (next: number) => void;
	step?: number;
	min?: number;
	max?: number;
	title?: string;
	suffix?: string;
	disabled?: boolean;
}) {
	return (
		<span className="row" style={{ gap: 2 }}>
			<input
				title={title}
				type="number"
				step={step}
				min={min}
				max={max}
				disabled={disabled}
				defaultValue={value ?? 0}
				key={`${title}:${value}`}
				onBlur={(event) => {
					const parsed = Number(event.target.value);
					if (Number.isFinite(parsed)) onCommit(parsed);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") (event.target as HTMLInputElement).blur();
				}}
				style={{ maxWidth: 90 }}
			/>
			{suffix && <span className="hint">{suffix}</span>}
		</span>
	);
}

function TemplatesCard() {
	const templates = useTemplates();
	const outs = useOuts();
	const [targetOut, setTargetOut] = useState<Record<string, string>>({});

	return (
		<div className="card">
			<div className="card__head">
				<h2>Анимации / шаблоны</h2>
				<div className="row">
					<button className="tiny primary" onClick={() => saveTemplate(newTemplate("layers"))}>
						+ отрисовка
					</button>
					<button className="tiny" onClick={() => saveTemplate(newTemplate("code"))}>
						+ код
					</button>
				</div>
			</div>

			{templates.length === 0 && (
				<div className="hint">Нет анимаций. Создайте первую — она появится в редакторе.</div>
			)}

			<div className="list">
				{templates.map((template) => {
					const bindings = collectBindingPaths(template);
					const outId = targetOut[template.id] ?? outs[0]?.id ?? "";
					return (
						<div className="col" key={template.id} style={{ gap: 4 }}>
							<div className="item">
								<span className="grow" style={{ display: "flex", gap: 6, alignItems: "center" }}>
									<input
										defaultValue={template.name}
										key={`name:${template.id}`}
										onBlur={(event) => {
											const name = event.target.value.trim();
											if (name && name !== template.name) {
												saveTemplate({ ...clone(template), name });
											}
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter") (event.target as HTMLInputElement).blur();
										}}
									/>
								</span>
								<span className="badge">{template.kind === "code" ? "код" : "слои"}</span>
								<span className="hint">{template.layers?.length ?? 0} сл.</span>
								<button
									className="tiny"
									title="Дублировать"
									onClick={() => duplicateTemplate(template.id)}
								>
									⧉
								</button>
								<button
									className="tiny danger"
									title="Удалить"
									onClick={() => {
										if (confirm(`Удалить «${template.name}»?`)) deleteTemplate(template.id);
									}}
								>
									×
								</button>
							</div>
							<div className="row" style={{ paddingLeft: 4 }}>
								<span className="hint grow mono small" title={bindings.join(", ")}>
									{bindings.length ? `{{${bindings.join("}}, {{")}}}` : "нет переменных"}
								</span>
								{outs.length > 0 && (
									<>
										<select
											value={outId}
											onChange={(event) =>
												setTargetOut({ ...targetOut, [template.id]: event.target.value })
											}
											style={{ maxWidth: 140 }}
										>
											{outs.map((out) => (
												<option key={out.id} value={out.id}>
													{out.name}
												</option>
											))}
										</select>
										<button
											className="tiny"
											disabled={!outId}
											onClick={() => outId && addItem(outId, template.id)}
										>
											разместить на out
										</button>
									</>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function ItemRow({ out, item }: { out: Out; item: OutItem }) {
	const templates = useTemplates();
	const runtime = useRuntime();
	const template = getTemplate(item.templateId);
	const playing = (runtime.playing?.[out.id] ?? []).includes(item.id);
	const videoMode = item.playback.holdMode === "video";
	const hasVideo = hasVideoLayer(template);
	const videoDuration = useVideoDuration(
		item.templateId,
		videoMode && hasVideo,
		videoLayerSignature(template),
	);

	return (
		<div
			className="item"
			data-out={out.id}
			data-item={item.id}
			style={{ flexWrap: "wrap", alignItems: "flex-start" }}
		>
			<div className="col grow" style={{ gap: 4 }}>
				<div className="row">
					<input
						type="checkbox"
						checked={item.enabled}
						title="Включено"
						onChange={(event) => updateItem(out.id, item.id, { enabled: event.target.checked })}
					/>
					<strong className="grow">{template?.name ?? item.templateId}</strong>
					{playing && <span className="badge badge--ok">играет</span>}
				</div>

				<div className="row">
					<label className="field" style={{ maxWidth: 90 }}>
						режим
						<select
							value={item.playback.mode}
							onChange={(event) =>
								updateItemPlayback(out.id, item.id, {
									mode: event.target.value === "loop" ? "loop" : "once",
								})
							}
						>
							<option value="once">once</option>
							<option value="loop">loop</option>
						</select>
					</label>

					{item.playback.mode === "loop" && (
						<label className="field" style={{ maxWidth: 100 }}>
							период, мс
							<NumberInput
								title="period"
								value={item.playback.intervalMs}
								min={250}
								step={250}
								onCommit={(value) => updateItemPlayback(out.id, item.id, { intervalMs: value })}
							/>
						</label>
					)}

					<label className="field" style={{ maxWidth: 100 }}>
						держать, мс
						<NumberInput
							title="hold"
							value={item.playback.holdMs}
							min={0}
							step={250}
							disabled={videoMode}
							onCommit={(value) => updateItemPlayback(out.id, item.id, { holdMs: value })}
						/>
					</label>

					{item.playback.mode === "loop" && (
						<label className="row small" style={{ maxWidth: 120, gap: 4 }}>
							<input
								type="checkbox"
								checked={item.playback.autoStart}
								onChange={(event) =>
									updateItemPlayback(out.id, item.id, { autoStart: event.target.checked })
								}
							/>
							авто-старт
						</label>
					)}
				</div>

				<div className="row small" style={{ gap: 6 }} data-hold-scope="item">
					<label className="row small" style={{ gap: 4, cursor: "pointer" }}>
						<input
							type="checkbox"
							data-hold-mode
							checked={videoMode}
							onChange={(event) =>
								updateItemPlayback(out.id, item.id, {
									holdMode: event.target.checked ? "video" : "fixed",
								})
							}
						/>
						длительность = видео
					</label>
					{videoMode ? (
						<span className="hint" data-hold-hint>
							{videoHoldHint(videoDuration, hasVideo)}
						</span>
					) : null}
				</div>

				<div className="row">
					<label className="field" style={{ maxWidth: 80 }}>
						x, %
						<NumberInput
							title="x"
							step={0.5}
							value={item.x}
							onCommit={(value) => updateItem(out.id, item.id, { x: value })}
						/>
					</label>
					<label className="field" style={{ maxWidth: 80 }}>
						y, %
						<NumberInput
							title="y"
							step={0.5}
							value={item.y}
							onCommit={(value) => updateItem(out.id, item.id, { y: value })}
						/>
					</label>
					<label className="field" style={{ maxWidth: 80 }}>
						масштаб
						<NumberInput
							title="scale"
							step={0.05}
							value={item.scale}
							onCommit={(value) => updateItem(out.id, item.id, { scale: value })}
						/>
					</label>
				</div>
			</div>

			<div className="col" style={{ gap: 4 }}>
				<div className="row">
					<button className="tiny" title="Выше" onClick={() => moveItem(out.id, item.id, -1)}>
						↑
					</button>
					<button className="tiny" title="Ниже" onClick={() => moveItem(out.id, item.id, 1)}>
						↓
					</button>
				</div>
				<button className="tiny" onClick={() => triggerItem(out.id, item.id)}>
					проиграть
				</button>
				<select
					className="tiny"
					value=""
					title="Заменить анимацию"
					onChange={(event) => {
						if (event.target.value) {
							updateItem(out.id, item.id, { templateId: event.target.value });
						}
					}}
				>
					<option value="">заменить…</option>
					{templates.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.name}
						</option>
					))}
				</select>
				<button className="tiny danger" onClick={() => removeItem(out.id, item.id)}>
					удалить
				</button>
			</div>
		</div>
	);
}

function OutCard({ out }: { out: Out }) {
	const templates = useTemplates();
	const [copied, setCopied] = useState(false);
	const [pick, setPick] = useState("");
	const url = absoluteOutUrl(out.id);

	return (
		<div className="card">
			<div className="card__head">
				<input
					defaultValue={out.name}
					key={`outname:${out.id}`}
					onBlur={(event) => {
						const name = event.target.value.trim();
						if (name && name !== out.name) saveOut({ ...clone(out), name });
					}}
				/>
				<button
					className="tiny danger"
					onClick={() => {
						if (confirm(`Удалить out «${out.name}»?`)) deleteOut(out.id);
					}}
				>
					×
				</button>
			</div>

			<div className="row">
				<span className="hint mono">id: {out.id}</span>
				<label className="field" style={{ maxWidth: 90 }}>
					ширина
					<NumberInput
						title="w"
						value={out.width}
						min={1}
						onCommit={(value) => saveOut({ ...clone(out), width: value })}
					/>
				</label>
				<label className="field" style={{ maxWidth: 90 }}>
					высота
					<NumberInput
						title="h"
						value={out.height}
						min={1}
						onCommit={(value) => saveOut({ ...clone(out), height: value })}
					/>
				</label>
			</div>

			<div className="out-link" style={{ marginTop: 6 }}>
				<input readOnly value={url} onFocus={(event) => event.target.select()} />
				<button
					className="tiny"
					onClick={() => {
						void copyText(url).then(() => {
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						});
					}}
				>
					{copied ? "✓" : "копировать"}
				</button>
			</div>

			<div className="divider" />

			<div className="list">
				{out.items.map((item) => (
					<ItemRow key={item.id} out={out} item={item} />
				))}
				{out.items.length === 0 && <div className="hint">Анимации ещё не размещены.</div>}
			</div>

			<div className="row" style={{ marginTop: 6 }}>
				<select value={pick} onChange={(event) => setPick(event.target.value)}>
					<option value="">выберите анимацию…</option>
					{templates.map((template) => (
						<option key={template.id} value={template.id}>
							{template.name}
						</option>
					))}
				</select>
				<button
					disabled={!pick}
					onClick={() => {
						if (!pick) return;
						addItem(out.id, pick);
						setPick("");
					}}
				>
					Добавить на out
				</button>
			</div>
		</div>
	);
}

function App() {
	const outs = useOuts();
	return (
		<>
			<div className="row row--between" style={{ marginBottom: 8 }}>
				<h1>notGT — Titles &amp; Outs</h1>
				<button onClick={() => createOut()}>+ новый out</button>
			</div>

			<TemplatesCard />

			<h2>Out'ы</h2>
			{outs.length === 0 && (
				<div className="hint">
					Out — это один Browser Source в OBS. Создайте хотя бы один и скопируйте ссылку.
				</div>
			)}
			{outs.map((out) => (
				<OutCard key={out.id} out={out} />
			))}
		</>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
