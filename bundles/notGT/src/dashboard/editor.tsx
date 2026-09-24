/**
 * notGT — Editor dashboard panel (fullbleed).
 *
 * Visual authoring for `kind: "layers"` templates (react-konva canvas, layer
 * list, property inspector) and for `kind: "code"` templates (HTML/CSS/JS with
 * a live iframe preview built by the real graphics runtime).
 *
 * Editing happens on a local clone of the selected template; nothing touches
 * the Replicant until "Сохранить" (which is also implied by Preview / Show).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { buildCodeDocument } from "../graphics/code-runtime";
import { interpolate } from "../shared/binding";
import type {
	CodeBlock,
	Layer,
	LayerStyle,
	LayerType,
	TemplateKind,
	TitleData,
	TitleTemplate,
} from "../shared/types";
import { EditorCanvas } from "./editor/canvas";
import {
	CheckField,
	ColorField,
	FONT_FAMILIES,
	Field,
	InlineName,
	LAYER_TYPE_LABEL,
	NumField,
	Section,
	SelectField,
	TRANSITION_LABEL,
	TRANSITION_TYPES,
	TextField,
	clamp,
	layerDisplayName,
	resolveAssetUrl,
	round,
	sortByZ,
} from "./editor/ui";
import {
	absoluteOutUrl,
	clone,
	copyText,
	defaultPlayback,
	defaultTransition,
	deleteTemplate,
	duplicateTemplate,
	flattenData,
	formatMs,
	getDb,
	getTemplate,
	hideTitle,
	newId,
	newTemplate,
	saveTemplate,
	showTitle,
	toggleTitle,
	triggerTemplate,
	useOuts,
	useTemplates,
	useTitleData,
} from "./shared";

// ------------------------------------------------------------------ helpers

const LAYER_ICON: Record<LayerType, string> = {
	text: "T",
	shape: "◻",
	image: "▣",
	gif: "▶",
};

const TEXT_ALIGNS: Array<{ value: NonNullable<LayerStyle["align"]>; label: string }> = [
	{ value: "left", label: "слева" },
	{ value: "center", label: "по центру" },
	{ value: "right", label: "справа" },
];

const VERTICAL_ALIGNS: Array<{ value: NonNullable<LayerStyle["verticalAlign"]>; label: string }> = [
	{ value: "top", label: "сверху" },
	{ value: "middle", label: "по центру" },
	{ value: "bottom", label: "снизу" },
];

const TEXT_TRANSFORMS: Array<{ value: NonNullable<LayerStyle["textTransform"]>; label: string }> = [
	{ value: "none", label: "как есть" },
	{ value: "uppercase", label: "ВЕРХНИЙ РЕГИСТР" },
	{ value: "lowercase", label: "нижний регистр" },
];

const FONT_WEIGHTS: Array<{ value: string; label: string }> = [
	{ value: "300", label: "300 light" },
	{ value: "400", label: "400 regular" },
	{ value: "500", label: "500 medium" },
	{ value: "600", label: "600 semibold" },
	{ value: "700", label: "700 bold" },
	{ value: "800", label: "800 extrabold" },
	{ value: "900", label: "900 black" },
];

function normalizeZ(layers: Layer[]): Layer[] {
	return sortByZ(layers).map((layer, index) => ({ ...layer, z: index + 1 }));
}

function makeLayer(type: LayerType, z: number): Layer {
	const base: Layer = {
		id: newId("layer"),
		type,
		x: 20,
		y: 40,
		z,
		style: { opacity: 1, rotation: 0 },
	};
	if (type === "text") {
		return {
			...base,
			name: "Текст",
			text: "Новый текст",
			width: 40,
			style: {
				...base.style,
				fontFamily: "Inter, 'Segoe UI', Roboto, Arial, sans-serif",
				fontSize: 56,
				fontWeight: 700,
				color: "#ffffff",
				align: "left",
				lineHeight: 1.15,
				textTransform: "none",
			},
		};
	}
	if (type === "shape") {
		return {
			...base,
			name: "Фигура",
			shape: "rect",
			width: 30,
			height: 12,
			style: { ...base.style, fill: "#4aa8ff", radius: 8 },
		};
	}
	return {
		...base,
		name: type === "gif" ? "GIF" : "Картинка",
		src: "",
		width: 24,
		height: 24,
		style: { ...base.style },
	};
}

/** Textarea used for layer text and code blocks. */
function CodeArea({
	label,
	value,
	onChange,
	rows,
	placeholder,
}: {
	label?: string;
	value: string | undefined;
	onChange: (value: string) => void;
	rows?: number;
	placeholder?: string;
}) {
	return (
		<Field label={label}>
			<textarea
				className="ed-code"
				spellCheck={false}
				rows={rows ?? 8}
				value={value ?? ""}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	);
}

// ------------------------------------------------------------- template list

function TemplateList({
	templates,
	selectedId,
	draft,
	onSelect,
	onCreate,
	onDuplicate,
	onDelete,
	onRename,
}: {
	templates: TitleTemplate[];
	selectedId: string | null;
	draft: TitleTemplate | null;
	onSelect: (id: string) => void;
	onCreate: (kind: TemplateKind) => void;
	onDuplicate: (id: string) => void;
	onDelete: (id: string) => void;
	onRename: (id: string, name: string) => void;
}) {
	return (
		<div className="ed-card">
			<div className="ed-card__head">
				<strong>Анимации</strong>
				<span className="ed-muted ed-small">{templates.length}</span>
			</div>
			<div className="ed-list">
				{templates.map((template) => {
					const active = template.id === selectedId;
					const name = active && draft ? draft.name : template.name;
					return (
						<div
							key={template.id}
							className={`ed-list-item${active ? " is-selected" : ""}`}
							onClick={() => onSelect(template.id)}
						>
							<span className={`ed-badge ed-badge--${template.kind}`}>
								{template.kind === "code" ? "код" : "слои"}
							</span>
							<span className="ed-list-item__name">
								<InlineName
									value={name}
									placeholder="Без имени"
									onChange={(next) => onRename(template.id, next)}
								/>
							</span>
							<span className="ed-list-item__actions" onClick={(event) => event.stopPropagation()}>
								<button
									type="button"
									className="ed-icon-btn"
									title="Дублировать"
									onClick={() => onDuplicate(template.id)}
								>
									⧉
								</button>
								<button
									type="button"
									className="ed-icon-btn ed-icon-btn--danger"
									title="Удалить"
									onClick={() => onDelete(template.id)}
								>
									✕
								</button>
							</span>
						</div>
					);
				})}
			</div>
			<div className="ed-row ed-mt">
				<button type="button" onClick={() => onCreate("layers")}>
					+ Слои
				</button>
				<button type="button" onClick={() => onCreate("code")}>
					+ Код
				</button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- layer list

function LayerList({
	layers,
	selectedLayerId,
	onSelect,
	onRename,
	onPatch,
	onMove,
	onDelete,
	onAdd,
}: {
	layers: Layer[];
	selectedLayerId: string | null;
	onSelect: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onPatch: (id: string, patch: Partial<Layer>) => void;
	onMove: (id: string, delta: number) => void;
	onDelete: (id: string) => void;
	onAdd: (type: LayerType) => void;
}) {
	const ordered = useMemo(() => sortByZ(layers).reverse(), [layers]);
	return (
		<div className="ed-card">
			<div className="ed-card__head">
				<strong>Слои</strong>
				<span className="ed-muted ed-small">{layers.length}</span>
			</div>
			<div className="ed-row ed-mb">
				<button type="button" onClick={() => onAdd("text")}>
					+ Текст
				</button>
				<button type="button" onClick={() => onAdd("shape")}>
					+ Фигура
				</button>
				<button type="button" onClick={() => onAdd("image")}>
					+ Картинка
				</button>
				<button type="button" onClick={() => onAdd("gif")}>
					+ GIF
				</button>
			</div>
			{ordered.length === 0 ? (
				<p className="ed-hint">Слоёв пока нет — добавьте текст, фигуру или картинку.</p>
			) : (
				<div className="ed-list">
					{ordered.map((layer) => (
						<div
							key={layer.id}
							className={`ed-list-item${layer.id === selectedLayerId ? " is-selected" : ""}${
								layer.hidden ? " is-hidden" : ""
							}`}
							onClick={() => onSelect(layer.id)}
						>
							<span className="ed-layer-icon" title={LAYER_TYPE_LABEL[layer.type]}>
								{LAYER_ICON[layer.type]}
							</span>
							<span className="ed-list-item__name">
								<InlineName
									value={layer.name ?? ""}
									placeholder={layerDisplayName(layer)}
									onChange={(name) => onRename(layer.id, name)}
								/>
							</span>
							<span
								className="ed-list-item__actions"
								onClick={(event) => event.stopPropagation()}
							>
								<button
									type="button"
									className="ed-icon-btn"
									title="Выше"
									onClick={() => onMove(layer.id, 1)}
								>
									↑
								</button>
								<button
									type="button"
									className="ed-icon-btn"
									title="Ниже"
									onClick={() => onMove(layer.id, -1)}
								>
									↓
								</button>
								<button
									type="button"
									className={`ed-icon-btn${layer.hidden ? " is-on" : ""}`}
									title={layer.hidden ? "Показать" : "Скрыть"}
									onClick={() => onPatch(layer.id, { hidden: !layer.hidden })}
								>
									{layer.hidden ? "◌" : "◉"}
								</button>
								<button
									type="button"
									className={`ed-icon-btn${layer.locked ? " is-on" : ""}`}
									title={layer.locked ? "Разблокировать" : "Заблокировать"}
									onClick={() => onPatch(layer.id, { locked: !layer.locked })}
								>
									{layer.locked ? "🔒" : "🔓"}
								</button>
								<button
									type="button"
									className="ed-icon-btn ed-icon-btn--danger"
									title="Удалить"
									onClick={() => onDelete(layer.id)}
								>
									✕
								</button>
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ------------------------------------------------------------ layer inspector

function LayerInspector({
	layer,
	data,
	dataPaths,
	onPatch,
	onStyle,
}: {
	layer: Layer;
	data: TitleData;
	dataPaths: string[];
	onPatch: (patch: Partial<Layer>) => void;
	onStyle: (patch: Partial<LayerStyle>) => void;
}) {
	const style = layer.style ?? {};
	const srcPreview = layer.src
		? resolveAssetUrl(interpolate(layer.src, data))
		: "";

	return (
		<div className="ed-panel-body">
			<Section title={`Слой — ${LAYER_TYPE_LABEL[layer.type]}`}>
				<TextField
					label="Имя"
					value={layer.name}
					placeholder={layerDisplayName(layer)}
					onChange={(value) => onPatch({ name: value })}
				/>
				<div className="ed-grid2">
					<NumField
						label="X"
						suffix="%"
						step={0.5}
						value={layer.x}
						onChange={(value) => onPatch({ x: round(value) })}
					/>
					<NumField
						label="Y"
						suffix="%"
						step={0.5}
						value={layer.y}
						onChange={(value) => onPatch({ y: round(value) })}
					/>
					<NumField
						label="Ширина"
						suffix="%"
						step={0.5}
						value={layer.width}
						onChange={(value) => onPatch({ width: Math.max(0.1, round(value)) })}
					/>
					<NumField
						label="Высота"
						suffix="%"
						step={0.5}
						value={layer.height}
						onChange={(value) => onPatch({ height: Math.max(0.1, round(value)) })}
					/>
					<NumField
						label="Поворот"
						suffix="°"
						step={1}
						value={style.rotation ?? 0}
						onChange={(value) => onStyle({ rotation: round(value, 1) })}
					/>
					<NumField
						label="Прозрачность"
						step={0.05}
						min={0}
						max={1}
						value={style.opacity ?? 1}
						onChange={(value) => onStyle({ opacity: clamp(value, 0, 1) })}
					/>
					<NumField
						label="Z"
						step={1}
						value={layer.z}
						onChange={(value) => onPatch({ z: Math.round(value) })}
					/>
				</div>
				<div className="ed-row">
					<button
						type="button"
						className="ed-mini"
						title="Ширина/высота по содержимому"
						onClick={() => onPatch({ width: undefined, height: undefined })}
					>
						auto W/H
					</button>
					<CheckField
						label="скрыт"
						checked={Boolean(layer.hidden)}
						onChange={(value) => onPatch({ hidden: value })}
					/>
					<CheckField
						label="замок"
						checked={Boolean(layer.locked)}
						onChange={(value) => onPatch({ locked: value })}
					/>
				</div>
			</Section>

			{layer.type === "text" ? (
				<>
					<Section title="Текст">
						<CodeArea
							label="Содержимое (поддерживает {{path}})"
							value={layer.text}
							rows={3}
							placeholder="{{speaker.name ?? Имя}}"
							onChange={(value) => onPatch({ text: value })}
						/>
						<TextField
							label="Binding (переменная)"
							mono
							value={layer.binding}
							placeholder="speaker.name"
							onChange={(value) => onPatch({ binding: value })}
						/>
						{dataPaths.length > 0 ? (
							<SelectField
								label="Подставить путь из данных"
								value={undefined}
								options={dataPaths.map((path) => ({ value: path, label: path }))}
								onChange={(value) => onPatch({ binding: value })}
							/>
						) : null}
						<div className="ed-hint">
							Если binding задан, берётся его значение; иначе подставляются {"{{...}}"}.
						</div>
					</Section>

					<Section title="Типографика" defaultOpen={false}>
						<Field label="Шрифт">
							<input
								type="text"
								list="ed-fonts"
								value={style.fontFamily ?? ""}
								placeholder="Inter, Arial, sans-serif"
								onChange={(event) => onStyle({ fontFamily: event.target.value })}
							/>
							<datalist id="ed-fonts">
								{FONT_FAMILIES.map((font) => (
									<option key={font} value={font} />
								))}
							</datalist>
						</Field>
						<div className="ed-grid2">
							<NumField
								label="Размер"
								suffix="px"
								step={1}
								min={1}
								value={style.fontSize ?? 48}
								onChange={(value) => onStyle({ fontSize: Math.max(1, Math.round(value)) })}
							/>
							<SelectField
								label="Насыщенность"
								value={String(style.fontWeight ?? 400)}
								options={FONT_WEIGHTS}
								onChange={(value) => onStyle({ fontWeight: Number(value) })}
							/>
							<NumField
								label="Интерлиньяж"
								step={0.05}
								min={0.5}
								value={style.lineHeight ?? 1.2}
								onChange={(value) => onStyle({ lineHeight: clamp(value, 0.5, 5) })}
							/>
							<NumField
								label="Трекинг"
								suffix="px"
								step={0.1}
								value={style.letterSpacing ?? 0}
								onChange={(value) => onStyle({ letterSpacing: value })}
							/>
							<NumField
								label="Отступ"
								suffix="px"
								step={1}
								value={style.padding ?? 0}
								onChange={(value) => onStyle({ padding: value })}
							/>
							<SelectField
								label="Курсив"
								value={style.fontStyle ?? "normal"}
								options={[
									{ value: "normal", label: "обычный" },
									{ value: "italic", label: "курсив" },
								]}
								onChange={(value) => onStyle({ fontStyle: value })}
							/>
							<SelectField
								label="Выравнивание"
								value={style.align ?? "left"}
								options={TEXT_ALIGNS}
								onChange={(value) => onStyle({ align: value })}
							/>
							<SelectField
								label="По вертикали"
								value={style.verticalAlign ?? "top"}
								options={VERTICAL_ALIGNS}
								onChange={(value) => onStyle({ verticalAlign: value })}
							/>
							<SelectField
								label="Регистр"
								value={style.textTransform ?? "none"}
								options={TEXT_TRANSFORMS}
								onChange={(value) => onStyle({ textTransform: value })}
							/>
							<ColorField
								label="Цвет"
								value={style.color}
								onChange={(value) => onStyle({ color: value })}
							/>
						</div>
					</Section>

					<Section title="Обводка, тень, плашка" defaultOpen={false}>
						<div className="ed-grid2">
							<ColorField
								label="Цвет обводки"
								value={style.textStrokeColor}
								onChange={(value) => onStyle({ textStrokeColor: value })}
							/>
							<NumField
								label="Толщина обводки"
								suffix="px"
								step={1}
								value={style.textStrokeWidth ?? 0}
								onChange={(value) => onStyle({ textStrokeWidth: value })}
							/>
							<ColorField
								label="Цвет тени"
								value={style.shadowColor}
								onChange={(value) => onStyle({ shadowColor: value })}
							/>
							<NumField
								label="Размытие тени"
								suffix="px"
								step={1}
								value={style.shadowBlur ?? 0}
								onChange={(value) => onStyle({ shadowBlur: value })}
							/>
							<NumField
								label="Тень X"
								suffix="px"
								step={1}
								value={style.shadowOffsetX ?? 0}
								onChange={(value) => onStyle({ shadowOffsetX: value })}
							/>
							<NumField
								label="Тень Y"
								suffix="px"
								step={1}
								value={style.shadowOffsetY ?? 0}
								onChange={(value) => onStyle({ shadowOffsetY: value })}
							/>
							<ColorField
								label="Фон плашки"
								value={style.fill}
								onChange={(value) => onStyle({ fill: value })}
							/>
							<NumField
								label="Скругление"
								suffix="px"
								step={1}
								value={style.radius ?? 0}
								onChange={(value) => onStyle({ radius: Math.max(0, value) })}
							/>
						</div>
						<div className="ed-hint">
							Плашка рисуется только если заданы ширина и высота слоя.
						</div>
					</Section>
				</>
			) : null}

			{layer.type === "shape" ? (
				<Section title="Фигура">
					<SelectField
						label="Форма"
						value={layer.shape ?? "rect"}
						options={[
							{ value: "rect", label: "прямоугольник" },
							{ value: "ellipse", label: "эллипс" },
						]}
						onChange={(value) => onPatch({ shape: value })}
					/>
					<div className="ed-grid2">
						<ColorField
							label="Заливка"
							value={style.fill}
							onChange={(value) => onStyle({ fill: value })}
						/>
						<ColorField
							label="Обводка"
							value={style.stroke}
							onChange={(value) => onStyle({ stroke: value })}
						/>
						<NumField
							label="Толщина обводки"
							suffix="px"
							step={1}
							value={style.strokeWidth ?? 0}
							onChange={(value) => onStyle({ strokeWidth: Math.max(0, value) })}
						/>
						<NumField
							label="Скругление"
							suffix="px"
							step={1}
							value={style.radius ?? 0}
							onChange={(value) => onStyle({ radius: Math.max(0, value) })}
						/>
						<ColorField
							label="Цвет тени"
							value={style.shadowColor}
							onChange={(value) => onStyle({ shadowColor: value })}
						/>
						<NumField
							label="Размытие тени"
							suffix="px"
							step={1}
							value={style.shadowBlur ?? 0}
							onChange={(value) => onStyle({ shadowBlur: value })}
						/>
						<NumField
							label="Тень X"
							suffix="px"
							step={1}
							value={style.shadowOffsetX ?? 0}
							onChange={(value) => onStyle({ shadowOffsetX: value })}
						/>
						<NumField
							label="Тень Y"
							suffix="px"
							step={1}
							value={style.shadowOffsetY ?? 0}
							onChange={(value) => onStyle({ shadowOffsetY: value })}
						/>
					</div>
				</Section>
			) : null}

			{layer.type === "image" || layer.type === "gif" ? (
				<Section title={layer.type === "gif" ? "GIF" : "Картинка"}>
					<TextField
						label="URL или путь"
						mono
						value={layer.src}
						placeholder="media/logo.png или https://…"
						onChange={(value) => onPatch({ src: value })}
					/>
					<div className="ed-hint">
						Относительные пути ищутся в /bundles/notGT/graphics/. Поддерживаются {"{{...}}"}.
					</div>
					{srcPreview ? (
						<img className="ed-image-preview" src={srcPreview} alt="" />
					) : (
						<div className="ed-image-preview ed-image-preview--empty">нет изображения</div>
					)}
					<div className="ed-grid2">
						<NumField
							label="Скругление"
							suffix="px"
							step={1}
							value={style.radius ?? 0}
							onChange={(value) => onStyle({ radius: Math.max(0, value) })}
						/>
						<NumField
							label="Прозрачность"
							step={0.05}
							min={0}
							max={1}
							value={style.opacity ?? 1}
							onChange={(value) => onStyle({ opacity: clamp(value, 0, 1) })}
						/>
					</div>
				</Section>
			) : null}
		</div>
	);
}

// --------------------------------------------------------- template settings

function TemplateSettings({
	template,
	onPatch,
}: {
	template: TitleTemplate;
	onPatch: (patch: Partial<TitleTemplate>) => void;
}) {
	const inTransition = template.inTransition ?? defaultTransition();
	const outTransition = template.outTransition ?? defaultTransition();
	const playback = template.playback ?? defaultPlayback();

	return (
		<div className="ed-panel-body">
			<Section title="Холст шаблона">
				<div className="ed-grid2">
					<NumField
						label="Ширина"
						suffix="px"
						step={10}
						min={16}
						value={template.width}
						onChange={(value) => onPatch({ width: Math.max(16, Math.round(value)) })}
					/>
					<NumField
						label="Высота"
						suffix="px"
						step={10}
						min={16}
						value={template.height}
						onChange={(value) => onPatch({ height: Math.max(16, Math.round(value)) })}
					/>
				</div>
				<SelectField
					label="Тип анимации"
					value={template.kind}
					options={[
						{ value: "layers", label: "слои (визуальный редактор)" },
						{ value: "code", label: "код (HTML / CSS / JS)" },
					]}
					onChange={(value) => onPatch({ kind: value })}
				/>
				<div className="ed-hint">
					ID: <code>{template.id}</code>
				</div>
			</Section>

			<Section title="Появление" defaultOpen={false}>
				<SelectField
					label="Тип"
					value={inTransition.type}
					options={TRANSITION_TYPES.map((type) => ({
						value: type,
						label: TRANSITION_LABEL[type],
					}))}
					onChange={(value) => onPatch({ inTransition: { ...inTransition, type: value } })}
				/>
				<div className="ed-grid2">
					<NumField
						label="Длительность"
						suffix="ms"
						step={10}
						min={0}
						value={inTransition.durationMs}
						onChange={(value) =>
							onPatch({
								inTransition: { ...inTransition, durationMs: Math.max(0, Math.round(value)) },
							})
						}
					/>
					<TextField
						label="Easing"
						value={inTransition.easing}
						placeholder="ease-out"
						onChange={(value) => onPatch({ inTransition: { ...inTransition, easing: value } })}
					/>
				</div>
			</Section>

			<Section title="Исчезновение" defaultOpen={false}>
				<SelectField
					label="Тип"
					value={outTransition.type}
					options={TRANSITION_TYPES.map((type) => ({
						value: type,
						label: TRANSITION_LABEL[type],
					}))}
					onChange={(value) => onPatch({ outTransition: { ...outTransition, type: value } })}
				/>
				<div className="ed-grid2">
					<NumField
						label="Длительность"
						suffix="ms"
						step={10}
						min={0}
						value={outTransition.durationMs}
						onChange={(value) =>
							onPatch({
								outTransition: {
									...outTransition,
									durationMs: Math.max(0, Math.round(value)),
								},
							})
						}
					/>
					<TextField
						label="Easing"
						value={outTransition.easing}
						placeholder="ease-in"
						onChange={(value) => onPatch({ outTransition: { ...outTransition, easing: value } })}
					/>
				</div>
			</Section>

			<Section title="Проигрывание" defaultOpen={false}>
				<SelectField
					label="Режим"
					value={playback.mode}
					options={[
						{ value: "once", label: "once — по триггеру" },
						{ value: "loop", label: "loop — цикл" },
					]}
					onChange={(value) => onPatch({ playback: { ...playback, mode: value } })}
				/>
				<div className="ed-grid2">
					<NumField
						label="Интервал"
						suffix="ms"
						step={100}
						min={100}
						value={playback.intervalMs}
						onChange={(value) =>
							onPatch({ playback: { ...playback, intervalMs: Math.max(100, Math.round(value)) } })
						}
					/>
					<NumField
						label="Удержание"
						suffix="ms"
						step={100}
						min={100}
						value={playback.holdMs}
						onChange={(value) =>
							onPatch({ playback: { ...playback, holdMs: Math.max(100, Math.round(value)) } })
						}
					/>
				</div>
				<CheckField
					label="autoStart — запускать при старте"
					checked={playback.autoStart}
					onChange={(value) => onPatch({ playback: { ...playback, autoStart: value } })}
				/>
				<div className="ed-hint">
					Интервал {formatMs(playback.intervalMs)} · удержание {formatMs(playback.holdMs)}
				</div>
			</Section>
		</div>
	);
}

// --------------------------------------------------------------- code panel

function CodePreview({ template, data }: { template: TitleTemplate; data: TitleData }) {
	const [doc, setDoc] = useState("");
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		setDoc(buildCodeDocument(template, data));
	}, [template, data, nonce]);

	return (
		<div className="ed-center">
			<div className="ed-code-preview">
				<iframe
					className="ed-preview-frame"
					title="Предпросмотр код-анимации"
					sandbox="allow-scripts allow-same-origin"
					srcDoc={doc}
				/>
			</div>
			<div className="ed-canvas-status">
				<span>
					Живой предпросмотр {template.width}×{template.height}
				</span>
				<span>Пересобирается при каждом изменении кода</span>
				<button type="button" className="ed-mini" onClick={() => setNonce((value) => value + 1)}>
					Перезапустить
				</button>
			</div>
		</div>
	);
}

function CodeEditors({
	template,
	onCode,
}: {
	template: TitleTemplate;
	onCode: (patch: Partial<CodeBlock>) => void;
}) {
	const code = template.code ?? { html: "", css: "", js: "" };
	return (
		<div className="ed-panel-body">
			<Section title="HTML">
				<CodeArea value={code.html} rows={8} onChange={(value) => onCode({ html: value })} />
			</Section>
			<Section title="CSS">
				<CodeArea value={code.css} rows={10} onChange={(value) => onCode({ css: value })} />
			</Section>
			<Section title="JavaScript">
				<CodeArea value={code.js} rows={10} onChange={(value) => onCode({ js: value })} />
			</Section>
			<div className="ed-note">
				<strong>Доступно внутри анимации</strong>
				<ul>
					<li>
						<code>vars('path')</code> — значение переменной (2-й аргумент — fallback)
					</li>
					<li>
						<code>data</code> — весь стор переменных
					</li>
					<li>
						<code>onData(fn)</code> — вызов сразу и при каждом изменении данных
					</li>
					<li>
						<code>root</code> — контейнер анимации
					</li>
					<li>
						<code>[data-bind="path"]</code> — текст, обновляемый автоматически
					</li>
				</ul>
				<p>
					<code>{"{{path}}"}</code> в HTML и CSS подставляется один раз при загрузке — для
					живых значений используйте <code>vars()</code>, <code>onData()</code> и{" "}
					<code>data-bind</code>.
				</p>
				<p>Переходы (появление/исчезновение) и режим проигрывания применяются как обычно.</p>
			</div>
		</div>
	);
}

// -------------------------------------------------------------- empty state

function EmptyState({ onCreate }: { onCreate: (kind: TemplateKind) => void }) {
	return (
		<div className="ed-empty">
			<h2>Пока нет ни одной анимации</h2>
			<p className="ed-hint">
				Соберите титр из слоёв на холсте или напишите анимацию на HTML/CSS/JS.
			</p>
			<div className="ed-row ed-row--center">
				<button type="button" className="primary" onClick={() => onCreate("layers")}>
					Создать анимацию
				</button>
				<button type="button" onClick={() => onCreate("code")}>
					Создать код-анимацию
				</button>
			</div>
		</div>
	);
}

// --------------------------------------------------------------------- app

export function EditorApp() {
	const templates = useTemplates();
	const outs = useOuts();
	const data = useTitleData();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<TitleTemplate | null>(null);
	const [dirty, setDirty] = useState(false);
	const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
	const [outId, setOutId] = useState<string>("");
	const [flash, setFlash] = useState<string>("");

	const templatesRef = useRef(templates);
	const draftRef = useRef<TitleTemplate | null>(draft);
	const flashTimer = useRef<number | undefined>(undefined);

	useEffect(() => {
		templatesRef.current = templates;
	}, [templates]);

	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	const notify = useCallback((message: string) => {
		setFlash(message);
		if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(""), 2500);
	}, []);

	useEffect(
		() => () => {
			if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
		},
		[],
	);

	// Select the first template once the replicant arrives.
	useEffect(() => {
		if (selectedId !== null) return;
		if (templates.length === 0) return;
		setSelectedId(templates[0]!.id);
	}, [templates, selectedId]);

	// Drop the selection when the template disappears (deleted here or elsewhere).
	useEffect(() => {
		if (selectedId === null) return;
		if (getTemplate(selectedId)) return;
		setSelectedId(null);
		setDraft(null);
		setDirty(false);
		setSelectedLayerId(null);
	}, [templates, selectedId]);

	// Load a fresh working copy whenever the selection changes.
	useEffect(() => {
		if (selectedId === null) {
			setDraft(null);
			setSelectedLayerId(null);
			return;
		}
		const source =
			getTemplate(selectedId) ?? templatesRef.current.find((item) => item.id === selectedId);
		setDraft(source ? clone(source) : null);
		setDirty(false);
		setSelectedLayerId(null);
	}, [selectedId]);

	// Keep the layer selection valid.
	useEffect(() => {
		if (!selectedLayerId) return;
		if ((draft?.layers ?? []).some((layer) => layer.id === selectedLayerId)) return;
		setSelectedLayerId(null);
	}, [draft, selectedLayerId]);

	const mutate = useCallback((fn: (template: TitleTemplate) => TitleTemplate) => {
		setDraft((prev) => (prev ? fn(prev) : prev));
		setDirty(true);
	}, []);

	const updateLayer = useCallback(
		(id: string, patch: Partial<Layer>) => {
			mutate((template) => ({
				...template,
				layers: template.layers.map((layer) =>
					layer.id === id ? { ...layer, ...patch } : layer,
				),
			}));
		},
		[mutate],
	);

	const updateStyle = useCallback(
		(id: string, patch: Partial<LayerStyle>) => {
			mutate((template) => ({
				...template,
				layers: template.layers.map((layer) =>
					layer.id === id ? { ...layer, style: { ...layer.style, ...patch } } : layer,
				),
			}));
		},
		[mutate],
	);

	const updateTemplate = useCallback(
		(patch: Partial<TitleTemplate>) => {
			mutate((template) => ({ ...template, ...patch }));
		},
		[mutate],
	);

	const addLayer = useCallback((type: LayerType) => {
		const layer = makeLayer(type, 1);
		setDraft((prev) => {
			if (!prev) return prev;
			const layers = normalizeZ(prev.layers);
			layer.z = layers.length + 1;
			return { ...prev, layers: [...layers, layer] };
		});
		setDirty(true);
		setSelectedLayerId(layer.id);
	}, []);

	const deleteLayer = useCallback(
		(id: string) => {
			mutate((template) => ({
				...template,
				layers: normalizeZ(template.layers.filter((layer) => layer.id !== id)),
			}));
			setSelectedLayerId((prev) => (prev === id ? null : prev));
		},
		[mutate],
	);

	const moveLayer = useCallback(
		(id: string, delta: number) => {
			mutate((template) => {
				const layers = sortByZ(template.layers);
				const index = layers.findIndex((layer) => layer.id === id);
				const target = index + delta;
				if (index < 0 || target < 0 || target >= layers.length) return template;
				const moved = layers[index]!;
				layers[index] = layers[target]!;
				layers[target] = moved;
				return { ...template, layers: layers.map((layer, i) => ({ ...layer, z: i + 1 })) };
			});
		},
		[mutate],
	);

	const persist = useCallback((): TitleTemplate | null => {
		const current = draftRef.current;
		if (!current) return null;
		const saved = saveTemplate(current);
		draftRef.current = clone(saved);
		setDraft(clone(saved));
		setDirty(false);
		return saved;
	}, []);

	const createTemplate = (kind: TemplateKind) => {
		const saved = saveTemplate(newTemplate(kind));
		draftRef.current = clone(saved);
		setDraft(clone(saved));
		setDirty(false);
		setSelectedId(saved.id);
		notify(kind === "code" ? "Создана код-анимация" : "Создана анимация слоёв");
	};

	const selectTemplate = (id: string) => {
		if (id === selectedId) return;
		if (dirty && !window.confirm("Есть несохранённые изменения. Переключить без сохранения?")) {
			return;
		}
		setSelectedId(id);
	};

	const renameTemplate = (id: string, name: string) => {
		if (id === selectedId) {
			mutate((template) => ({ ...template, name }));
			return;
		}
		const template = getTemplate(id);
		if (!template) return;
		saveTemplate({ ...template, name });
	};

	const duplicate = (id: string) => {
		if (dirty && !window.confirm("Есть несохранённые изменения. Продолжить?")) return;
		const copy = duplicateTemplate(id);
		if (!copy) return;
		draftRef.current = clone(copy);
		setDraft(clone(copy));
		setDirty(false);
		setSelectedId(copy.id);
		notify(`Дубликат: ${copy.name}`);
	};

	const removeTemplate = (id: string) => {
		const template = getTemplate(id);
		if (!template) return;
		if (!window.confirm(`Удалить «${template.name}»?`)) return;
		const remaining = templates.filter((item) => item.id !== id);
		deleteTemplate(id);
		if (selectedId === id) {
			setSelectedId(remaining.length > 0 ? remaining[0]!.id : null);
			setDraft(null);
			setDirty(false);
			setSelectedLayerId(null);
		}
		notify("Шаблон удалён");
	};

	const preview = () => {
		const saved = persist();
		if (!saved) return;
		triggerTemplate(saved.id, outId || null);
		notify(`Preview → ${outId ? "выбранный out" : "все out'ы"}`);
	};

	const showOnOut = () => {
		const saved = persist();
		if (!saved) return;
		showTitle(saved.id, { outId: outId || null });
		notify("Показано");
	};

	const hideOnOut = () => {
		hideTitle({ outId: outId || null });
		notify("Скрыто");
	};

	const toggleOnOut = () => {
		const saved = persist();
		if (!saved) return;
		toggleTitle(saved.id, { outId: outId || null });
		notify("Переключено");
	};

	// Arrow-key nudging for the selected layer.
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (!selectedLayerId) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable)
			) {
				return;
			}
			const step = event.shiftKey ? 1 : 0.1;
			let dx = 0;
			let dy = 0;
			if (event.key === "ArrowLeft") dx = -step;
			else if (event.key === "ArrowRight") dx = step;
			else if (event.key === "ArrowUp") dy = -step;
			else if (event.key === "ArrowDown") dy = step;
			else return;
			event.preventDefault();
			mutate((template) => ({
				...template,
				layers: template.layers.map((layer) =>
					layer.id === selectedLayerId
						? { ...layer, x: round(layer.x + dx), y: round(layer.y + dy) }
						: layer,
				),
			}));
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [selectedLayerId, mutate]);

	const dataPaths = useMemo(() => flattenData(data).map((row) => row.path), [data]);
	const templatesLoaded = getDb().templates.value !== undefined;
	const draftLayers = draft?.layers ?? [];
	const selectedLayer = draftLayers.find((layer) => layer.id === selectedLayerId) ?? null;
	const activeOut = outs.find((out) => out.id === outId) ?? null;

	return (
		<div className="ed-root">
			<div className="ed-toolbar">
				<span className="ed-toolbar__title">notGT — Editor</span>
				{draft ? (
					<>
						<span className={`ed-chip${dirty ? " is-dirty" : ""}`}>
							{dirty ? "● не сохранено" : "сохранено"}
						</span>
						<span className="ed-vline" />
						<button type="button" onClick={() => addLayer("text")}>
							+ Текст
						</button>
						<button type="button" onClick={() => addLayer("shape")}>
							+ Фигура
						</button>
						<button type="button" onClick={() => addLayer("image")}>
							+ Картинка
						</button>
						<button type="button" onClick={() => addLayer("gif")}>
							+ GIF
						</button>
						<span className="ed-vline" />
						<button type="button" className="primary" onClick={persist}>
							Сохранить
						</button>
						<button type="button" onClick={preview}>
							Preview
						</button>
					</>
				) : null}
				<span className="ed-spacer" />
				{flash ? <span className="ed-flash">{flash}</span> : null}
			</div>

			<div className="ed-toolbar ed-toolbar--sub">
				<span className="ed-muted ed-small">Show on out:</span>
				<select
					className="ed-out-select"
					value={outId}
					onChange={(event) => setOutId(event.target.value)}
				>
					<option value="">все out&apos;ы</option>
					{outs.map((out) => (
						<option key={out.id} value={out.id}>
							{out.name}
						</option>
					))}
				</select>
				<button type="button" onClick={showOnOut} disabled={!draft}>
					Показать
				</button>
				<button type="button" onClick={toggleOnOut} disabled={!draft}>
					Toggle
				</button>
				<button type="button" className="danger" onClick={hideOnOut}>
					Скрыть
				</button>
				<span className="ed-vline" />
				<button
					type="button"
					disabled={!activeOut}
					title={activeOut ? "Скопировать URL для OBS" : "Выберите конкретный out"}
					onClick={() => {
						if (!activeOut) return;
						void copyText(absoluteOutUrl(activeOut.id)).then(() => notify("URL скопирован"));
					}}
				>
					Копировать URL
				</button>
				{activeOut ? (
					<span className="ed-muted ed-small ed-ellipsis">{absoluteOutUrl(activeOut.id)}</span>
				) : (
					<span className="ed-muted ed-small">выберите out, чтобы получить URL для OBS</span>
				)}
			</div>

			<div className="ed-main">
				<div className="ed-side">
					<TemplateList
						templates={templates}
						selectedId={selectedId}
						draft={draft}
						onSelect={selectTemplate}
						onCreate={createTemplate}
						onDuplicate={duplicate}
						onDelete={removeTemplate}
						onRename={renameTemplate}
					/>
					{draft && draft.kind === "layers" ? (
						<LayerList
							layers={draftLayers}
							selectedLayerId={selectedLayerId}
							onSelect={setSelectedLayerId}
							onRename={(id, name) => updateLayer(id, { name })}
							onPatch={updateLayer}
							onMove={moveLayer}
							onDelete={deleteLayer}
							onAdd={addLayer}
						/>
					) : null}
					{draft && draft.kind === "code" ? (
						<div className="ed-card">
							<div className="ed-card__head">
								<strong>Код-анимация</strong>
							</div>
							<p className="ed-hint">
								Слои недоступны: шаблон собирается из HTML/CSS/JS. Предпросмотр — в центре,
								редакторы — справа.
							</p>
						</div>
					) : null}
				</div>

				{draft ? (
					draft.kind === "layers" ? (
						<EditorCanvas
							template={draft}
							data={data}
							selectedLayerId={selectedLayerId}
							onSelectLayer={setSelectedLayerId}
							onLayerChange={updateLayer}
						/>
					) : (
						<CodePreview template={draft} data={data} />
					)
				) : templatesLoaded ? (
					<div className="ed-center">
						<EmptyState onCreate={createTemplate} />
					</div>
				) : (
					<div className="ed-center">
						<div className="ed-empty">
							<p className="ed-hint">Загрузка шаблонов…</p>
						</div>
					</div>
				)}

				<div className="ed-side ed-side--right">
					{draft ? (
						<>
							{draft.kind === "layers" ? (
								selectedLayer ? (
									<LayerInspector
										layer={selectedLayer}
										data={data}
										dataPaths={dataPaths}
										onPatch={(patch) => updateLayer(selectedLayer.id, patch)}
										onStyle={(patch) => updateStyle(selectedLayer.id, patch)}
									/>
								) : (
									<div className="ed-card">
										<div className="ed-card__head">
											<strong>Инспектор</strong>
										</div>
										<p className="ed-hint">
											Выберите слой на холсте или в списке слева, чтобы изменить его
											свойства. Ниже — настройки всего шаблона.
										</p>
									</div>
								)
							) : (
								<CodeEditors
									template={draft}
									onCode={(patch) =>
										updateTemplate({ code: { ...(draft.code ?? { html: "", css: "", js: "" }), ...patch } })
									}
								/>
							)}
							<TemplateSettings template={draft} onPatch={updateTemplate} />
						</>
					) : (
						<div className="ed-card">
							<div className="ed-card__head">
								<strong>Настройки</strong>
							</div>
							<p className="ed-hint">Выберите или создайте анимацию.</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------- mount

const container = document.getElementById("notgt-root");
if (container) {
	createRoot(container).render(<EditorApp />);
} else {
	console.error("[notGT] #notgt-root not found — editor panel not mounted");
}
