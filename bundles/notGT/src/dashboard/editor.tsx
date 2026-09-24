/**
 * notGT — Editor dashboard panel (fullbleed).
 *
 * The canvas *is* the selected out: the `Out:` selector drives the stage, every
 * animation placed on that out is drawn with the same placement math the
 * graphics runtime uses (`out.width x out.height`, `item.x% / item.y%`,
 * `scale(item.scale)` from the top-left corner), and the operator edits layers
 * directly on that composite.
 *
 * Editing model:
 *   - placements (x/y/scale/enabled/playback/order, add/remove item) are
 *     Replicant writes applied immediately;
 *   - layer + template edits happen on a local draft clone of the active
 *     animation and only reach the Replicant on "Сохранить" (also implied by
 *     Preview / Показать / Toggle).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { buildCodeDocument, codeSource } from "../graphics/code-runtime";
import { interpolate } from "../shared/binding";
import type {
	CodeBlock,
	Layer,
	LayerStyle,
	LayerType,
	Out,
	OutItem,
	PlaybackConfig,
	TemplateKind,
	TitleData,
	TitleTemplate,
	VariableSelection,
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
	addItem,
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
	moveItem,
	newId,
	newTemplate,
	removeItem,
	saveTemplate,
	showTitle,
	toggleTitle,
	triggerItem,
	triggerTemplate,
	updateItem,
	updateItemPlayback,
	useOuts,
	useRuntime,
	useSelection,
	useTemplates,
	useTitleData,
} from "./shared";

// ------------------------------------------------------------------ helpers

const LAYER_ICON: Record<LayerType, string> = {
	text: "T",
	shape: "◻",
	image: "▣",
	gif: "▶",
	video: "🎞",
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

const PLAYBACK_MODES: Array<{ value: PlaybackConfig["mode"]; label: string }> = [
	{ value: "once", label: "once — по триггеру" },
	{ value: "loop", label: "loop — цикл" },
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
	if (type === "video") {
		// A fresh video layer has a visible 16:9 box and the runtime defaults
		// spelled out, so it is selectable/visible even before a `src` is set.
		return {
			...base,
			name: "Видео",
			src: "",
			width: 32,
			height: 18,
			style: {
				...base.style,
				videoLoop: true,
				videoAutoplay: true,
				videoMuted: true,
				videoRate: 1,
			},
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

function orderedItems(out: Out | null): OutItem[] {
	if (!out) return [];
	return [...out.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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

// ------------------------------------------------- "на этом out'е" item list

function OutItemsList({
	out,
	templates,
	draft,
	activeItemId,
	playing,
	onActivate,
	onToggleEnabled,
	onMove,
	onTrigger,
	onRemove,
}: {
	out: Out;
	templates: TitleTemplate[];
	draft: TitleTemplate | null;
	activeItemId: string | null;
	playing: string[];
	onActivate: (itemId: string) => void;
	onToggleEnabled: (itemId: string, enabled: boolean) => void;
	onMove: (itemId: string, delta: number) => void;
	onTrigger: (itemId: string) => void;
	onRemove: (itemId: string) => void;
}) {
	const items = orderedItems(out);
	return (
		<div className="ed-card">
			<div className="ed-card__head">
				<strong>На этом out&apos;е</strong>
				<span className="ed-muted ed-small">{items.length}</span>
			</div>
			{items.length === 0 ? (
				<p className="ed-hint">
					На этом out&apos;е пока ничего нет — разместите анимацию из библиотеки ниже.
				</p>
			) : (
				<div className="ed-list">
					{items.map((item) => {
						const template = templates.find((candidate) => candidate.id === item.templateId);
						const name =
							draft && draft.id === item.templateId
								? draft.name
								: template?.name ?? "—";
						return (
							<div
								key={item.id}
								className={`ed-list-item${item.id === activeItemId ? " is-selected" : ""}${
									item.enabled ? "" : " is-hidden"
								}`}
								onClick={() => onActivate(item.id)}
							>
								<input
									type="checkbox"
									title={item.enabled ? "Выключить на out'е" : "Включить на out'е"}
									checked={item.enabled}
									onClick={(event) => event.stopPropagation()}
									onChange={(event) => onToggleEnabled(item.id, event.target.checked)}
								/>
								<span className="ed-list-item__name" title={name}>
									{name}
								</span>
								{playing.includes(item.id) ? (
									<span className="ed-badge ed-badge--live">играет</span>
								) : null}
								<span
									className="ed-list-item__actions"
									onClick={(event) => event.stopPropagation()}
								>
									<button
										type="button"
										className="ed-icon-btn"
										title="Выше"
										onClick={() => onMove(item.id, -1)}
									>
										↑
									</button>
									<button
										type="button"
										className="ed-icon-btn"
										title="Ниже"
										onClick={() => onMove(item.id, 1)}
									>
										↓
									</button>
									<button
										type="button"
										className="ed-icon-btn"
										title="Проиграть"
										onClick={() => onTrigger(item.id)}
									>
										проиграть
									</button>
									<button
										type="button"
										className="ed-icon-btn ed-icon-btn--danger"
										title="Убрать с out'а"
										onClick={() => onRemove(item.id)}
									>
										✕
									</button>
								</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ----------------------------------------------------------- template library

function TemplateLibrary({
	templates,
	placedIds,
	activeTemplateId,
	libraryId,
	draft,
	onSelect,
	onPlace,
	onCreate,
	onDuplicate,
	onDelete,
	onRename,
}: {
	templates: TitleTemplate[];
	placedIds: Set<string>;
	activeTemplateId: string | null;
	libraryId: string | null;
	draft: TitleTemplate | null;
	onSelect: (id: string) => void;
	onPlace: (id: string) => void;
	onCreate: (kind: TemplateKind) => void;
	onDuplicate: (id: string) => void;
	onDelete: (id: string) => void;
	onRename: (id: string, name: string) => void;
}) {
	return (
		<div className="ed-card">
			<div className="ed-card__head">
				<strong>Все анимации</strong>
				<span className="ed-muted ed-small">{templates.length}</span>
			</div>
			{templates.length === 0 ? (
				<p className="ed-hint">Анимаций пока нет — создайте первую.</p>
			) : (
				<div className="ed-list">
					{templates.map((template) => {
						const highlight =
							template.id === activeTemplateId || template.id === libraryId;
						const placed = placedIds.has(template.id);
						const name = highlight && draft ? draft.name : template.name;
						return (
							<div
								key={template.id}
								className={`ed-list-item${highlight ? " is-selected" : ""}`}
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
								<span
									className="ed-list-item__actions"
									onClick={(event) => event.stopPropagation()}
								>
									{!placed ? (
										<button
											type="button"
											className="ed-mini"
											title="Разместить на выбранном out'е"
											onClick={() => onPlace(template.id)}
										>
											на out
										</button>
									) : null}
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
			)}
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
				<strong>Слои активной анимации</strong>
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
				<button type="button" onClick={() => onAdd("video")}>
					+ Видео
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
	selection,
	dataPaths,
	onPatch,
	onStyle,
}: {
	layer: Layer;
	data: TitleData;
	selection: VariableSelection;
	dataPaths: string[];
	onPatch: (patch: Partial<Layer>) => void;
	onStyle: (patch: Partial<LayerStyle>) => void;
}) {
	const style = layer.style ?? {};
	const srcPreview = layer.src
		? resolveAssetUrl(interpolate(layer.src, data, selection))
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

			{layer.type === "video" ? (
				<Section title="Видео">
					<TextField
						label="URL или путь"
						mono
						value={layer.src}
						placeholder="media/clip.mp4 или https://…"
						onChange={(value) => onPatch({ src: value })}
					/>
					<div className="ed-hint">
						Файлы из <code>graphics/media/</code> отдаются напрямую:{" "}
						<code>/bundles/notGT/graphics/media/&lt;файл&gt;</code>. Относительные
						пути ищутся в /bundles/notGT/graphics/. Поддерживаются {"{{...}}"}.
					</div>
					<div className="ed-grid2">
						<CheckField
							label="videoAutoplay — автозапуск"
							checked={style.videoAutoplay ?? true}
							onChange={(value) => onStyle({ videoAutoplay: value })}
						/>
						<CheckField
							label="videoLoop — цикл"
							checked={style.videoLoop ?? true}
							onChange={(value) => onStyle({ videoLoop: value })}
						/>
						<CheckField
							label="videoMuted — без звука"
							checked={style.videoMuted ?? true}
							onChange={(value) => onStyle({ videoMuted: value })}
						/>
						<NumField
							label="videoRate — скорость"
							step={0.05}
							min={0.05}
							max={4}
							value={style.videoRate ?? 1}
							onChange={(value) => onStyle({ videoRate: clamp(value, 0.05, 4) })}
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
						Воспроизведением управляет графика; в редакторе показывается статичный
						кадр.
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

// ------------------------------------------------------- placement inspector

function PlacementInspector({
	out,
	item,
	template,
	onPatch,
	onPlayback,
	onRemove,
	onFitOut,
}: {
	out: Out;
	item: OutItem;
	template: TitleTemplate;
	onPatch: (patch: Partial<OutItem>) => void;
	onPlayback: (patch: Partial<PlaybackConfig>) => void;
	onRemove: () => void;
	onFitOut: () => void;
}) {
	const playback = item.playback ?? defaultPlayback();
	const fittedScale = template.width > 0 ? out.width / template.width : 1;

	return (
		<div className="ed-panel-body">
			<Section title="Размещение на out'е">
				<div className="ed-grid2">
					<NumField
						label="X"
						suffix="%"
						step={0.5}
						value={item.x}
						onChange={(value) => onPatch({ x: round(value) })}
					/>
					<NumField
						label="Y"
						suffix="%"
						step={0.5}
						value={item.y}
						onChange={(value) => onPatch({ y: round(value) })}
					/>
					<NumField
						label="Масштаб"
						step={0.05}
						min={0.02}
						max={20}
						value={item.scale}
						onChange={(value) => onPatch({ scale: round(clamp(value, 0.02, 20), 4) })}
					/>
					<Field label="По ширине out'а">
						<button type="button" className="ed-mini" onClick={onFitOut}>
							по размеру out&apos;а
						</button>
					</Field>
				</div>
				<div className="ed-hint">
					X/Y — проценты от {out.width}×{out.height}; масштаб умножает бокс анимации{" "}
					{template.width}×{template.height} (полная ширина ≈ {round(fittedScale, 3)}).
				</div>
				<CheckField
					label="включено на out'е"
					checked={item.enabled}
					onChange={(value) => onPatch({ enabled: value })}
				/>
				<button type="button" className="danger" onClick={onRemove}>
					Убрать с out&apos;а
				</button>
			</Section>

			<Section title="Проигрывание на out'е" defaultOpen={false}>
				<SelectField
					label="Режим"
					value={playback.mode}
					options={PLAYBACK_MODES}
					onChange={(value) => onPlayback({ mode: value })}
				/>
				<div className="ed-grid2">
					<NumField
						label="Интервал"
						suffix="ms"
						step={100}
						min={100}
						value={playback.intervalMs}
						onChange={(value) => onPlayback({ intervalMs: Math.max(100, Math.round(value)) })}
					/>
					<NumField
						label="Удержание"
						suffix="ms"
						step={100}
						min={100}
						value={playback.holdMs}
						onChange={(value) => onPlayback({ holdMs: Math.max(100, Math.round(value)) })}
					/>
				</div>
				<CheckField
					label="autoStart — запускать при старте"
					checked={playback.autoStart}
					onChange={(value) => onPlayback({ autoStart: value })}
				/>
				<div className="ed-hint">
					Интервал {formatMs(playback.intervalMs)} · удержание {formatMs(playback.holdMs)}
				</div>
			</Section>
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
			<Section title="Анимация (шаблон)">
				<TextField
					label="Имя"
					value={template.name}
					onChange={(value) => onPatch({ name: value })}
				/>
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

			<Section title="Проигрывание по умолчанию" defaultOpen={false}>
				<SelectField
					label="Режим"
					value={playback.mode}
					options={PLAYBACK_MODES}
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

// ---------------------------------------------------------------- code panel

function CodePreviewCard({ template, data }: { template: TitleTemplate; data: TitleData }) {
	const [doc, setDoc] = useState("");
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		setDoc(buildCodeDocument(template, data));
	}, [template, data, nonce]);

	return (
		<div className="ed-card">
			<div className="ed-card__head">
				<strong>Живой предпросмотр</strong>
				<button type="button" className="ed-mini" onClick={() => setNonce((value) => value + 1)}>
					Перезапустить
				</button>
			</div>
			<div className="ed-code-preview ed-code-preview--panel">
				<iframe
					className="ed-preview-frame"
					title="Предпросмотр код-анимации"
					sandbox="allow-scripts allow-same-origin"
					srcDoc={doc}
				/>
			</div>
			<p className="ed-hint">
				{template.width}×{template.height} · пересобирается при каждом изменении кода
			</p>
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
			{codeSource(template) === "file" && code.src ? (
				<div className="ed-hint">
					HTML/CSS/JS загружаются из файла <code>{code.src}</code>. Если написать HTML
					здесь, он перекроет файл.
				</div>
			) : null}
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

// --------------------------------------------------------------------- app

export function EditorApp() {
	const templates = useTemplates();
	const outs = useOuts();
	const data = useTitleData();
	const runtime = useRuntime();
	const selection = useSelection();

	const [outId, setOutId] = useState<string>("");
	const [activeItemId, setActiveItemId] = useState<string | null>(null);
	const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
	const [libraryId, setLibraryId] = useState<string | null>(null);
	const [draft, setDraft] = useState<TitleTemplate | null>(null);
	const [dirty, setDirty] = useState(false);
	const [flash, setFlash] = useState("");

	const dirtyRef = useRef(dirty);
	const draftRef = useRef<TitleTemplate | null>(draft);
	const userCleared = useRef(false);
	const flashTimer = useRef<number | undefined>(undefined);

	useEffect(() => {
		dirtyRef.current = dirty;
	}, [dirty]);

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

	const out = outs.find((candidate) => candidate.id === outId) ?? null;
	const items = useMemo(() => orderedItems(out), [out]);
	const activeItem = items.find((item) => item.id === activeItemId) ?? null;
	const editingTemplateId = activeItem?.templateId ?? libraryId ?? null;

	// Pick a valid out as soon as the replicant arrives (or after a deletion).
	useEffect(() => {
		if (outs.length === 0) {
			if (outId !== "") setOutId("");
			return;
		}
		if (!outs.some((candidate) => candidate.id === outId)) setOutId(outs[0]!.id);
	}, [outs, outId]);

	// Whenever the out changes, drop the per-out selection and default to its
	// first animation (or the first library entry so Preview always has a target).
	useEffect(() => {
		userCleared.current = false;
		const target = outs.find((candidate) => candidate.id === outId) ?? null;
		const sorted = orderedItems(target);
		setSelectedLayerId(null);
		setActiveItemId(sorted.length > 0 ? sorted[0]!.id : null);
		setLibraryId(sorted.length === 0 && templates[0] ? templates[0]!.id : null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [outId]);

	// Late-arriving replicants: choose a default once data exists.
	useEffect(() => {
		if (activeItemId || libraryId || userCleared.current) return;
		const sorted = orderedItems(out);
		if (sorted.length > 0) {
			setActiveItemId(sorted[0]!.id);
			return;
		}
		if (templates.length > 0) setLibraryId(templates[0]!.id);
	}, [activeItemId, libraryId, out, templates]);

	// Load a fresh working copy whenever the edited template changes.
	useEffect(() => {
		if (!editingTemplateId) {
			setDraft(null);
			setDirty(false);
			return;
		}
		const source = getTemplate(editingTemplateId);
		setDraft(source ? clone(source) : null);
		setDirty(false);
		setSelectedLayerId(null);
	}, [editingTemplateId]);

	// Keep the layer selection valid.
	useEffect(() => {
		if (!selectedLayerId) return;
		if ((draft?.layers ?? []).some((layer) => layer.id === selectedLayerId)) return;
		setSelectedLayerId(null);
	}, [draft, selectedLayerId]);

	const confirmDiscard = useCallback((): boolean => {
		if (!dirtyRef.current) return true;
		return window.confirm("Есть несохранённые изменения. Продолжить без сохранения?");
	}, []);

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

	const persist = useCallback((): TitleTemplate | null => {
		const current = draftRef.current;
		if (!current) return null;
		const saved = saveTemplate(current);
		draftRef.current = clone(saved);
		setDraft(clone(saved));
		setDirty(false);
		return saved;
	}, []);

	// ------------------------------------------------------------ placement

	const patchItem = (itemId: string, patch: Partial<OutItem>) => {
		if (!out) return;
		updateItem(out.id, itemId, patch);
	};

	const patchItemPlayback = (itemId: string, patch: Partial<PlaybackConfig>) => {
		if (!out) return;
		updateItemPlayback(out.id, itemId, patch);
	};

	const moveItemInOut = (itemId: string, delta: number) => {
		if (!out) return;
		moveItem(out.id, itemId, delta);
	};

	const triggerItemOnOut = (itemId: string) => {
		if (!out) return;
		triggerItem(out.id, itemId);
		notify("Триггер отправлен");
	};

	const removeItemFromOut = (itemId: string) => {
		if (!out) return;
		if (itemId === activeItemId && dirty) {
			if (!window.confirm("Убрать анимацию с out'а? Несохранённые изменения будут потеряны.")) {
				return;
			}
		}
		removeItem(out.id, itemId);
		if (itemId === activeItemId) {
			setActiveItemId(null);
			setSelectedLayerId(null);
			setDraft(null);
			setDirty(false);
		}
		notify("Убрано с out'а");
	};

	const fitItemToOut = (item: OutItem) => {
		if (!out) return;
		const template = getTemplate(item.templateId);
		if (!template || template.width <= 0) return;
		updateItem(out.id, item.id, { scale: round(out.width / template.width, 4) });
	};

	// ------------------------------------------------------------- selection

	const handleSelectItem = (itemId: string | null) => {
		if (itemId === null) {
			userCleared.current = true;
			setActiveItemId(null);
			setSelectedLayerId(null);
			return;
		}
		if (itemId === activeItemId) {
			setSelectedLayerId(null);
			return;
		}
		if (!confirmDiscard()) return;
		userCleared.current = false;
		setActiveItemId(itemId);
		setSelectedLayerId(null);
		setLibraryId(null);
	};

	const chooseOut = (id: string) => {
		if (id === outId) return;
		if (!confirmDiscard()) return;
		setOutId(id);
	};

	const selectLibrary = (templateId: string) => {
		const placed = items.find((item) => item.templateId === templateId);
		if (placed) {
			handleSelectItem(placed.id);
			return;
		}
		if (!confirmDiscard()) return;
		userCleared.current = false;
		setLibraryId(templateId);
		setActiveItemId(null);
		setSelectedLayerId(null);
	};

	const placeTemplate = (templateId: string) => {
		if (!out) return;
		if (editingTemplateId && editingTemplateId !== templateId && !confirmDiscard()) return;
		const item = addItem(out.id, templateId);
		if (!item) return;
		userCleared.current = false;
		setActiveItemId(item.id);
		setSelectedLayerId(null);
		setLibraryId(null);
		notify("Анимация размещена на out'е");
	};

	// ------------------------------------------------------------- templates

	const startNewAnimation = (): { item: OutItem; template: TitleTemplate } | null => {
		if (!out) return null;
		const base = newTemplate("layers");
		const saved = saveTemplate({
			...base,
			name: "Новая анимация",
			width: out.width,
			height: out.height,
			layers: [],
		});
		const item = addItem(out.id, saved.id);
		if (!item) return null;
		userCleared.current = false;
		setActiveItemId(item.id);
		setSelectedLayerId(null);
		setLibraryId(null);
		draftRef.current = clone(saved);
		setDraft(clone(saved));
		setDirty(false);
		return { item, template: saved };
	};

	const addLayer = (type: LayerType) => {
		let working = draft && draft.kind === "layers" ? draft : null;
		if (!working) {
			if (editingTemplateId && !confirmDiscard()) return;
			const started = startNewAnimation();
			if (!started) return;
			working = started.template;
		}
		const layer = makeLayer(type, 1);
		const layers = normalizeZ(working.layers ?? []);
		layer.z = layers.length + 1;
		const next = { ...working, layers: [...layers, layer] };
		draftRef.current = next;
		setDraft(next);
		setDirty(true);
		setSelectedLayerId(layer.id);
	};

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

	const createTemplate = (kind: TemplateKind) => {
		if (!confirmDiscard()) return;
		const saved = saveTemplate(newTemplate(kind));
		if (out) {
			const item = addItem(out.id, saved.id);
			if (item) setActiveItemId(item.id);
		}
		setLibraryId(null);
		setSelectedLayerId(null);
		notify(kind === "code" ? "Создана код-анимация" : "Создана анимация слоёв");
	};

	const duplicate = (id: string) => {
		if (!confirmDiscard()) return;
		const copy = duplicateTemplate(id);
		if (!copy) return;
		if (out) {
			const item = addItem(out.id, copy.id);
			if (item) setActiveItemId(item.id);
		}
		setLibraryId(null);
		setSelectedLayerId(null);
		notify(`Дубликат: ${copy.name}`);
	};

	const removeTemplate = (id: string) => {
		const template = getTemplate(id);
		if (!template) return;
		if (!window.confirm(`Удалить «${template.name}»?`)) return;
		if (editingTemplateId === id) {
			setActiveItemId(null);
			setLibraryId(null);
			setDraft(null);
			setDirty(false);
			setSelectedLayerId(null);
		}
		deleteTemplate(id);
		notify("Анимация удалена");
	};

	const renameTemplate = (id: string, name: string) => {
		if (id === editingTemplateId) {
			mutate((template) => ({ ...template, name }));
			return;
		}
		const template = getTemplate(id);
		if (!template) return;
		saveTemplate({ ...template, name });
	};

	// --------------------------------------------------------------- toolbar

	const resolveForAction = (): TitleTemplate | null => {
		const saved = persist();
		if (saved) return saved;
		if (editingTemplateId) return getTemplate(editingTemplateId) ?? null;
		return null;
	};

	const preview = () => {
		const target = resolveForAction();
		if (!target) return;
		triggerTemplate(target.id, outId || null);
		notify(`Preview → ${out ? out.name : "out"}`);
	};

	const showOnOut = () => {
		const target = resolveForAction();
		if (!target) return;
		showTitle(target.id, { outId: outId || null });
		notify("Показано");
	};

	const toggleOnOut = () => {
		const target = resolveForAction();
		if (!target) return;
		toggleTitle(target.id, { outId: outId || null });
		notify("Переключено");
	};

	const hideOnOut = () => {
		hideTitle({ outId: outId || null });
		notify("Скрыто");
	};

	// Arrow-key nudging: the layer when one is selected, otherwise the placement.
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
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

			if (selectedLayerId && draft) {
				event.preventDefault();
				mutate((template) => ({
					...template,
					layers: template.layers.map((layer) =>
						layer.id === selectedLayerId
							? { ...layer, x: round(layer.x + dx), y: round(layer.y + dy) }
							: layer,
					),
				}));
				return;
			}
			if (activeItemId && out) {
				const item = out.items.find((candidate) => candidate.id === activeItemId);
				if (!item) return;
				event.preventDefault();
				updateItem(out.id, item.id, {
					x: round(item.x + dx),
					y: round(item.y + dy),
				});
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [selectedLayerId, draft, activeItemId, out, mutate]);

	// ---------------------------------------------------------------- derive

	const dataPaths = useMemo(() => flattenData(data).map((row) => row.path), [data]);
	const templatesLoaded = getDb().templates.value !== undefined;
	const outsLoaded = getDb().outs.value !== undefined;
	const draftLayers = draft?.layers ?? [];
	const selectedLayer = draftLayers.find((layer) => layer.id === selectedLayerId) ?? null;
	const playingIds = out ? runtime.playing?.[out.id] ?? [] : [];
	const placedIds = useMemo(() => new Set(items.map((item) => item.templateId)), [items]);

	return (
		<div className="ed-root">
			<div className="ed-toolbar">
				<span className="ed-toolbar__title">notGT — Editor</span>
				{draft ? (
					<span className={`ed-chip${dirty ? " is-dirty" : ""}`}>
						{dirty ? "● не сохранено" : "сохранено"}
					</span>
				) : null}
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
				<button type="button" onClick={() => addLayer("video")}>
					+ Видео
				</button>
				<span className="ed-vline" />
				<button type="button" className="primary" onClick={persist} disabled={!draft}>
					Сохранить
				</button>
				<button type="button" onClick={preview} disabled={!draft && !editingTemplateId}>
					Preview
				</button>
				<span className="ed-spacer" />
				{flash ? <span className="ed-flash">{flash}</span> : null}
			</div>

			<div className="ed-toolbar ed-toolbar--sub">
				<span className="ed-muted ed-small">Out:</span>
				<select
					className="ed-out-select"
					value={outId}
					onChange={(event) => chooseOut(event.target.value)}
				>
					{outs.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.name}
						</option>
					))}
				</select>
				<button type="button" onClick={showOnOut} disabled={!draft && !editingTemplateId}>
					Показать
				</button>
				<button type="button" onClick={toggleOnOut} disabled={!draft && !editingTemplateId}>
					Toggle
				</button>
				<button type="button" className="danger" onClick={hideOnOut} disabled={!out}>
					Скрыть
				</button>
				<span className="ed-vline" />
				<button
					type="button"
					disabled={!out}
					title={out ? "Скопировать URL для OBS" : "Нет out'а"}
					onClick={() => {
						if (!out) return;
						void copyText(absoluteOutUrl(out.id)).then(() => notify("URL скопирован"));
					}}
				>
					Копировать URL
				</button>
				{out ? (
					<span className="ed-muted ed-small ed-ellipsis">{absoluteOutUrl(out.id)}</span>
				) : (
					<span className="ed-muted ed-small">создайте out, чтобы получить URL для OBS</span>
				)}
			</div>

			<div className="ed-main">
				<div className="ed-side">
					{out ? (
						<OutItemsList
							out={out}
							templates={templates}
							draft={draft}
							activeItemId={activeItemId}
							playing={playingIds}
							onActivate={handleSelectItem}
							onToggleEnabled={(itemId, enabled) => patchItem(itemId, { enabled })}
							onMove={moveItemInOut}
							onTrigger={triggerItemOnOut}
							onRemove={removeItemFromOut}
						/>
					) : (
						<div className="ed-card">
							<div className="ed-card__head">
								<strong>На этом out&apos;е</strong>
							</div>
							<p className="ed-hint">Нет ни одного out&apos;а.</p>
						</div>
					)}

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
								Слои недоступны: анимация собирается из HTML/CSS/JS. Редакторы и
								предпросмотр — справа, на холсте — плейсхолдер.
							</p>
						</div>
					) : null}

					<TemplateLibrary
						templates={templates}
						placedIds={placedIds}
						activeTemplateId={editingTemplateId}
						libraryId={libraryId}
						draft={draft}
						onSelect={selectLibrary}
						onPlace={placeTemplate}
						onCreate={createTemplate}
						onDuplicate={duplicate}
						onDelete={removeTemplate}
						onRename={renameTemplate}
					/>
				</div>

				{out ? (
					<EditorCanvas
						out={out}
						templates={templates}
						draft={draft}
						activeItemId={activeItemId}
						selectedLayerId={selectedLayerId}
						data={data}
						selection={selection}
						onSelectItem={handleSelectItem}
						onSelectLayer={setSelectedLayerId}
						onLayerChange={updateLayer}
						onItemChange={patchItem}
					/>
				) : (
					<div className="ed-center">
						<div className="ed-empty">
							<h2>Нет out&apos;а</h2>
							<p className="ed-hint">
								Создайте out во вкладке «notGT — Titles &amp; Outs».
							</p>
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
										selection={selection}
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
											Выберите слой на холсте или в списке слева. Ниже — размещение
											анимации на out&apos;е и настройки шаблона.
										</p>
									</div>
								)
							) : (
								<>
									<CodePreviewCard template={draft} data={data} />
									<CodeEditors
										template={draft}
										onCode={(patch) =>
											updateTemplate({
												code: {
													...(draft.code ?? { html: "", css: "", js: "" }),
													...patch,
												},
											})
										}
									/>
								</>
							)}

							{activeItem && out ? (
								<PlacementInspector
									out={out}
									item={activeItem}
									template={draft}
									onPatch={(patch) => patchItem(activeItem.id, patch)}
									onPlayback={(patch) => patchItemPlayback(activeItem.id, patch)}
									onRemove={() => removeItemFromOut(activeItem.id)}
									onFitOut={() => fitItemToOut(activeItem)}
								/>
							) : (
								<div className="ed-card">
									<div className="ed-card__head">
										<strong>Размещение на out&apos;е</strong>
									</div>
									<p className="ed-hint">
										Эта анимация ещё не размещена на выбранном out&apos;е.
									</p>
									<button
										type="button"
										onClick={() => placeTemplate(draft.id)}
										disabled={!out}
									>
										Разместить на out&apos;е
									</button>
								</div>
							)}

							<TemplateSettings template={draft} onPatch={updateTemplate} />
						</>
					) : (
						<div className="ed-card">
							<div className="ed-card__head">
								<strong>Инспектор</strong>
							</div>
							<p className="ed-hint">
								{outsLoaded && templatesLoaded
									? "Выберите или создайте анимацию."
									: "Загрузка…"}
							</p>
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
