/**
 * notGT editor — the react-konva canvas. The stage *is* the selected out.
 *
 * The placement math mirrors `src/graphics/out.ts` exactly:
 *   stage = out.width x out.height design px, scaled by `fit` to the panel;
 *   an animation is a `template.width x template.height` box placed at
 *   `left: item.x% of out.width`, `top: item.y% of out.height`, then scaled by
 *   `item.scale` around its top-left corner. Layers are positioned in percent of
 *   that animation box.
 *
 * Interaction model:
 *   - the active animation has a draggable frame (and an explicit move handle)
 *     that edits the placement (`item.x` / `item.y`), plus a corner handle that
 *     edits `item.scale`;
 *   - layers of the active animation can be selected, dragged (`layer.x/y`) and
 *     transformed (`layer.width/height`);
 *   - every other animation is dimmed and only responds to a click that makes
 *     it active.
 */
import type Konva from "konva";
import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import {
	Ellipse,
	Group,
	Image as KonvaImage,
	Layer as KonvaLayer,
	Line,
	Rect,
	Stage,
	Text,
	Transformer,
} from "react-konva";

import { interpolate } from "../../shared/binding";
import type {
	Layer,
	LayerStyle,
	Out,
	OutItem,
	TitleData,
	TitleTemplate,
	VariableSelection,
} from "../../shared/types";
import {
	resolveAssetUrl,
	resolveText,
	round,
	sortByZ,
	useElementSize,
	useHtmlImage,
	useHtmlVideo,
} from "./ui";

type KonvaEvent<T extends Event> = Konva.KonvaEventObject<T>;

/** Screen-px size of the placement handles (constant, never scaled). */
const HANDLE = 18;

export interface EditorCanvasProps {
	out: Out;
	/** Saved templates (used for every animation except the active draft). */
	templates: TitleTemplate[];
	/** Unsaved working copy of the active animation's template. */
	draft: TitleTemplate | null;
	activeItemId: string | null;
	selectedLayerId: string | null;
	data: TitleData;
	selection: VariableSelection;
	onSelectItem: (itemId: string | null) => void;
	onSelectLayer: (layerId: string | null) => void;
	onLayerChange: (layerId: string, patch: Partial<Layer>) => void;
	onItemChange: (itemId: string, patch: Partial<OutItem>) => void;
}

interface Geometry {
	item: OutItem;
	template: TitleTemplate;
	scale: number;
	boxX: number;
	boxY: number;
	boxW: number;
	boxH: number;
	k: number;
}

export function EditorCanvas({
	out,
	templates,
	draft,
	activeItemId,
	selectedLayerId,
	data,
	selection,
	onSelectItem,
	onSelectLayer,
	onLayerChange,
	onItemChange,
}: EditorCanvasProps) {
	const { ref, width, height } = useElementSize<HTMLDivElement>();

	const designW = out.width > 0 ? out.width : 1920;
	const designH = out.height > 0 ? out.height : 1080;
	const availableW = Math.max(0, width - 24);
	const availableH = Math.max(0, height - 24);
	const fitRaw = Math.min(availableW / designW, availableH / designH);
	const fit = Number.isFinite(fitRaw) && fitRaw > 0 ? fitRaw : 0;

	const stageW = Math.max(1, Math.round(designW * fit));
	const stageH = Math.max(1, Math.round(designH * fit));

	const items = useMemo(
		() => [...(out.items ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
		[out.items],
	);

	const byId = useMemo(() => {
		const map = new Map<string, TitleTemplate>();
		for (const template of templates) map.set(template.id, template);
		if (draft) map.set(draft.id, draft);
		return map;
	}, [templates, draft]);

	const geoms = useMemo<Geometry[]>(() => {
		const list: Geometry[] = [];
		for (const item of items) {
			const template = byId.get(item.templateId);
			if (!template) continue;
			const scale = item.scale && item.scale > 0 ? item.scale : 1;
			const k = scale * fit;
			list.push({
				item,
				template,
				scale,
				boxX: ((item.x ?? 0) / 100) * stageW,
				boxY: ((item.y ?? 0) / 100) * stageH,
				boxW: Math.max(1, template.width * k),
				boxH: Math.max(1, template.height * k),
				k,
			});
		}
		return list;
	}, [items, byId, fit, stageW, stageH]);

	const activeGeom = geoms.find((g) => g.item.id === activeItemId) ?? null;

	// --- node refs (only the active animation's layers matter for the transformer)
	const nodeRefs = useRef(new Map<string, Konva.Node>());
	const refSetters = useRef(new Map<string, (node: Konva.Node | null) => void>());
	const transformerRef = useRef<Konva.Transformer | null>(null);

	const registerRef = useCallback((itemId: string, layerId: string) => {
		const key = `${itemId}::${layerId}`;
		let setter = refSetters.current.get(key);
		if (!setter) {
			setter = (node: Konva.Node | null) => {
				if (node) nodeRefs.current.set(key, node);
				else nodeRefs.current.delete(key);
			};
			refSetters.current.set(key, setter);
		}
		return setter;
	}, []);

	const selectedLayer =
		activeGeom && activeGeom.template.kind === "layers"
			? (activeGeom.template.layers ?? []).find((layer) => layer.id === selectedLayerId) ?? null
			: null;

	useEffect(() => {
		const transformer = transformerRef.current;
		if (!transformer) return;
		const key =
			activeItemId && selectedLayerId ? `${activeItemId}::${selectedLayerId}` : "";
		const node = key ? nodeRefs.current.get(key) : undefined;
		transformer.nodes(node ? [node] : []);
		transformer.getLayer()?.batchDraw();
	}, [activeItemId, selectedLayerId, geoms, fit]);

	// 5% grid + centre crosshair.
	const verticals = useMemo(() => {
		const out: number[] = [];
		for (let percent = 5; percent < 100; percent += 5) out.push((percent / 100) * stageW);
		return out;
	}, [stageW]);
	const horizontals = useMemo(() => {
		const out: number[] = [];
		for (let percent = 5; percent < 100; percent += 5) out.push((percent / 100) * stageH);
		return out;
	}, [stageH]);

	const stageSummary = `${designW}×${designH} · анимаций ${geoms.length}`;

	return (
		<div className="ed-center">
			<div className="ed-canvas-wrap" ref={ref}>
				{fit > 0 ? (
					<div className="ed-canvas-stage" style={{ width: stageW, height: stageH }}>
						<Stage
							width={stageW}
							height={stageH}
							onMouseDown={(event: KonvaEvent<MouseEvent>) => {
								if (event.target === event.target.getStage()) {
									onSelectItem(null);
									onSelectLayer(null);
								}
							}}
						>
							<KonvaLayer>
								{verticals.map((x) => (
									<Line
										key={`v${x}`}
										points={[x, 0, x, stageH]}
										stroke={
											Math.abs(x - stageW / 2) < 0.75
												? "rgba(255,255,255,0.16)"
												: "rgba(255,255,255,0.055)"
										}
										strokeWidth={1}
										listening={false}
									/>
								))}
								{horizontals.map((y) => (
									<Line
										key={`h${y}`}
										points={[0, y, stageW, y]}
										stroke={
											Math.abs(y - stageH / 2) < 0.75
												? "rgba(255,255,255,0.16)"
												: "rgba(255,255,255,0.055)"
										}
										strokeWidth={1}
										listening={false}
									/>
								))}
								{/* 5% safe area + centre marker */}
								<Rect
									x={stageW * 0.05}
									y={stageH * 0.05}
									width={stageW * 0.9}
									height={stageH * 0.9}
									stroke="rgba(74,168,255,0.45)"
									strokeWidth={1}
									dash={[6, 6]}
									listening={false}
								/>
								<Rect
									x={stageW * 0.45}
									y={stageH * 0.45}
									width={stageW * 0.1}
									height={stageH * 0.1}
									stroke="rgba(74,168,255,0.22)"
									strokeWidth={1}
									listening={false}
								/>

								{/* Click-catchers for the dimmed animations. They are drawn
								    *below* every animation's content so they can never steal a
								    drag from the active one; the active box is instead clickable
								    through its own frame. */}
								{geoms
									.filter((geom) => geom.item.id !== activeItemId)
									.map((geom) => (
										<Rect
											key={`catcher:${geom.item.id}`}
											x={geom.boxX}
											y={geom.boxY}
											width={geom.boxW}
											height={geom.boxH}
											fill="rgba(0,0,0,0.001)"
											onMouseDown={(event: KonvaEvent<MouseEvent>) => {
												event.cancelBubble = true;
												onSelectItem(geom.item.id);
												onSelectLayer(null);
											}}
										/>
									))}

								{geoms.map((geom) => (
									<AnimatedItem
										key={geom.item.id}
										geom={geom}
										stageW={stageW}
										stageH={stageH}
										active={geom.item.id === activeItemId}
										selectedLayerId={selectedLayerId}
										data={data}
										selection={selection}
										onSelectItem={onSelectItem}
										onSelectLayer={onSelectLayer}
										onLayerChange={onLayerChange}
										onItemChange={onItemChange}
										registerRef={registerRef}
									/>
								))}

								{/* Handles are drawn last so they stay usable even when the
								    active animation sits below a later one. */}
								{activeGeom ? (
									<PlacementHandles
										geom={activeGeom}
										stageW={stageW}
										stageH={stageH}
										onItemChange={onItemChange}
									/>
								) : null}

								<Transformer
									ref={transformerRef}
									rotateEnabled={Boolean(selectedLayer && !selectedLayer.locked)}
									resizeEnabled={Boolean(selectedLayer && !selectedLayer.locked)}
									keepRatio={false}
									anchorSize={9}
									anchorStroke="#4aa8ff"
									anchorFill="#0d141c"
									anchorCornerRadius={2}
									borderStroke="#4aa8ff"
									borderDash={[4, 3]}
									rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
									boundBoxFunc={(oldBox, newBox) =>
										newBox.width < 6 || newBox.height < 6 ? oldBox : newBox
									}
								/>
							</KonvaLayer>
						</Stage>
					</div>
				) : (
					<div className="ed-canvas-placeholder">Область предпросмотра…</div>
				)}
			</div>

			<div className="ed-canvas-status">
				<span>
					Out: {out.name} ({stageSummary})
				</span>
				<span>Масштаб {Math.round(fit * 100)}%</span>
				{activeGeom ? (
					<span className="ed-ok">
						{activeGeom.template.name}: x {round(activeGeom.item.x)}% · y{" "}
						{round(activeGeom.item.y)}% · scale {round(activeGeom.scale, 3)}
					</span>
				) : (
					<span>
						Клик по анимации — выбрать · рамка/маркер — переместить · угол — масштаб
					</span>
				)}
			</div>
		</div>
	);
}

// -------------------------------------------------------------- one animation

function AnimatedItem({
	geom,
	stageW,
	stageH,
	active,
	selectedLayerId,
	data,
	selection,
	onSelectItem,
	onSelectLayer,
	onLayerChange,
	onItemChange,
	registerRef,
}: {
	geom: Geometry;
	stageW: number;
	stageH: number;
	active: boolean;
	selectedLayerId: string | null;
	data: TitleData;
	selection: VariableSelection;
	onSelectItem: (itemId: string | null) => void;
	onSelectLayer: (layerId: string | null) => void;
	onLayerChange: (layerId: string, patch: Partial<Layer>) => void;
	onItemChange: (itemId: string, patch: Partial<OutItem>) => void;
	registerRef: (itemId: string, layerId: string) => (node: Konva.Node | null) => void;
}) {
	const { item, template, boxX, boxY, boxW, boxH, k } = geom;
	const interactive = active && item.enabled !== false;
	const dim = active ? 1 : item.enabled === false ? 0.22 : 0.45;

	const moveTo = (node: Konva.Node) => {
		onItemChange(item.id, {
			x: round((item.x ?? 0) + (stageW > 0 ? (node.x() / stageW) * 100 : 0)),
			y: round((item.y ?? 0) + (stageH > 0 ? (node.y() / stageH) * 100 : 0)),
		});
		node.position({ x: 0, y: 0 });
	};

	return (
		<Group x={boxX} y={boxY} opacity={dim}>
			{/* Placement frame: transparent hit area behind the layers, so dragging
			    an empty part of the box moves the whole animation. */}
			{active ? (
				<Rect
					width={boxW}
					height={boxH}
					fill="rgba(0,0,0,0.001)"
					stroke="rgba(74,168,255,0.9)"
					strokeWidth={1}
					dash={[5, 4]}
					hitStrokeWidth={14}
					draggable
					onMouseDown={() => {
						onSelectItem(item.id);
						onSelectLayer(null);
					}}
					onDragEnd={(event: KonvaEvent<DragEvent>) => moveTo(event.target)}
				/>
			) : null}

			{template.kind === "code" ? (
				<CodePlaceholder template={template} boxW={boxW} boxH={boxH} />
			) : (
				sortByZ(template.layers ?? []).map((layer) => (
					<LayerNode
						key={layer.id}
						layer={layer}
						data={data}
						selection={selection}
						stageW={template.width * k}
						stageH={template.height * k}
						k={k}
						ky={k}
						interactive={interactive}
						listening={active}
						onSelect={() => onSelectLayer(layer.id)}
						onChange={(patch) => onLayerChange(layer.id, patch)}
						registerRef={registerRef(item.id, layer.id)}
					/>
				))
			)}
		</Group>
	);
}

function CodePlaceholder({
	template,
	boxW,
	boxH,
}: {
	template: TitleTemplate;
	boxW: number;
	boxH: number;
}) {
	const label = `${template.name} — код ${template.width}×${template.height}`;
	return (
		<Fragment>
			<Rect
				width={boxW}
				height={boxH}
				fill="rgba(255,190,90,0.06)"
				stroke="rgba(255,190,90,0.65)"
				strokeWidth={1}
				dash={[8, 6]}
				listening={false}
			/>
			<Text
				text={label}
				x={8}
				y={8}
				width={Math.max(10, boxW - 16)}
				fontSize={12}
				fill="rgba(255,200,120,0.95)"
				listening={false}
			/>
		</Fragment>
	);
}

// --------------------------------------------------------------- move + scale

function PlacementHandles({
	geom,
	stageW,
	stageH,
	onItemChange,
}: {
	geom: Geometry;
	stageW: number;
	stageH: number;
	onItemChange: (itemId: string, patch: Partial<OutItem>) => void;
}) {
	const { item, template, boxW, boxH, boxX, boxY } = geom;

	return (
		<Group x={boxX} y={boxY}>
			{/* Move handle (top-left). */}
			<Group
				x={0}
				y={0}
				draggable
				onDragEnd={(event: KonvaEvent<DragEvent>) => {
					const node = event.target;
					onItemChange(item.id, {
						x: round((item.x ?? 0) + (stageW > 0 ? (node.x() / stageW) * 100 : 0)),
						y: round((item.y ?? 0) + (stageH > 0 ? (node.y() / stageH) * 100 : 0)),
					});
					node.position({ x: 0, y: 0 });
				}}
			>
				<Rect
					width={HANDLE}
					height={HANDLE}
					fill="rgba(74,168,255,0.95)"
					cornerRadius={3}
					stroke="#0d141c"
					strokeWidth={1}
				/>
				<Text
					text="✥"
					x={2}
					y={2}
					width={HANDLE - 4}
					height={HANDLE - 4}
					align="center"
					verticalAlign="middle"
					fontSize={11}
					fill="#0d141c"
					listening={false}
				/>
			</Group>

			{/* Scale handle (bottom-right). */}
			<Group
				x={Math.max(0, boxW - HANDLE)}
				y={Math.max(0, boxH - HANDLE)}
				draggable
				onDragEnd={(event: KonvaEvent<DragEvent>) => {
					const node = event.target;
					const fit = fitOf(geom);
					const nextW = Math.max(8, node.x() + HANDLE);
					const nextScale =
						template.width > 0 ? nextW / (template.width * fit) : geom.scale;
					const clamped = Math.min(20, Math.max(0.02, nextScale));
					onItemChange(item.id, { scale: round(clamped, 4) });
					node.position({
						x: Math.max(0, template.width * clamped * fit - HANDLE),
						y: Math.max(0, template.height * clamped * fit - HANDLE),
					});
				}}
			>
				<Rect
					width={HANDLE}
					height={HANDLE}
					fill="rgba(255,209,102,0.95)"
					cornerRadius={3}
					stroke="#0d141c"
					strokeWidth={1}
				/>
				<Text
					text="⤡"
					x={1}
					y={1}
					width={HANDLE - 2}
					height={HANDLE - 2}
					align="center"
					verticalAlign="middle"
					fontSize={12}
					fill="#0d141c"
					listening={false}
				/>
			</Group>
		</Group>
	);
}

/** `fit` back out of the geometry (boxW = template.width * scale * fit). */
function fitOf(geom: Geometry): number {
	if (geom.template.width > 0 && geom.scale > 0) return geom.k / geom.scale;
	return 1;
}

// --------------------------------------------------------------- layer nodes

interface LayerNodeProps {
	layer: Layer;
	data: TitleData;
	selection: VariableSelection;
	stageW: number;
	stageH: number;
	k: number;
	ky: number;
	/** Belongs to the active placement and is neither locked nor hidden. */
	interactive: boolean;
	/** Belongs to the active placement (false = click-select only). */
	listening: boolean;
	onSelect: () => void;
	onChange: (patch: Partial<Layer>) => void;
	registerRef: (node: Konva.Node | null) => void;
}

function fontStyleOf(style: LayerStyle): string {
	const parts: string[] = [];
	if (style.fontStyle === "italic") parts.push("italic");
	const weight = style.fontWeight;
	if (weight !== undefined && weight !== "normal" && Number(weight) !== 400) {
		parts.push(String(weight));
	}
	return parts.length > 0 ? parts.join(" ") : "normal";
}

function applyTextTransform(text: string, mode: LayerStyle["textTransform"]): string {
	if (mode === "uppercase") return text.toUpperCase();
	if (mode === "lowercase") return text.toLowerCase();
	return text;
}

/** Short `видео — <file>` label for the empty/404 placeholder. */
function videoPlaceholderLabel(src: string): string {
	if (!src) return "видео";
	if (/^data:/i.test(src)) return "видео — data URI";
	const name = src.split(/[?#]/)[0]?.split("/").pop();
	return name ? `видео — ${name}` : "видео";
}

function LayerNode({
	layer,
	data,
	selection,
	stageW,
	stageH,
	k,
	ky,
	interactive,
	listening,
	onSelect,
	onChange,
	registerRef,
}: LayerNodeProps) {
	const style: LayerStyle = layer.style ?? {};
	const isImage = layer.type === "image" || layer.type === "gif";
	const imageSrc = isImage ? resolveAssetUrl(interpolate(layer.src ?? "", data, selection)) : "";
	const videoSrc =
		layer.type === "video" ? resolveAssetUrl(interpolate(layer.src ?? "", data, selection)) : "";
	const image = useHtmlImage(imageSrc);
	const { video, frame } = useHtmlVideo(videoSrc, {
		loop: style.videoLoop ?? true,
		muted: style.videoMuted ?? true,
		rate: style.videoRate ?? 1,
	});

	// The editor only paints a single video frame; Konva does not watch the
	// element, so force a redraw whenever a new picture is decoded.
	const videoNodeRef = useRef<Konva.Image | null>(null);
	const setVideoNode = useCallback(
		(node: Konva.Image | null) => {
			videoNodeRef.current = node;
			registerRef(node);
		},
		[registerRef],
	);
	useEffect(() => {
		if (!video) return;
		videoNodeRef.current?.getLayer()?.batchDraw();
	}, [video, frame]);

	// --- geometry (percent -> stage px)
	let w: number | undefined;
	let h: number | undefined;
	if (layer.width !== undefined) w = (layer.width / 100) * stageW;
	else if (isImage && image) w = (image.naturalWidth || image.width) * k;
	else if (layer.type === "video" && video) w = (video.videoWidth || 320) * k;
	if (layer.height !== undefined) h = (layer.height / 100) * stageH;
	else if (isImage && image) h = (image.naturalHeight || image.height) * ky;
	else if (layer.type === "video" && video) h = (video.videoHeight || 180) * ky;

	// Konva rotates/scales around (offsetX, offsetY); matching CSS means using
	// the box centre whenever we know the box.
	const originX = w !== undefined ? w / 2 : 0;
	const originY = h !== undefined ? h / 2 : 0;
	const posX = (layer.x / 100) * stageW + originX;
	const posY = (layer.y / 100) * stageH + originY;

	const opacity = layer.hidden ? 0.25 : style.opacity ?? 1;
	const rotation = style.rotation ?? 0;
	const draggable = interactive && !layer.locked && !layer.hidden;
	const shadowColor = style.shadowColor ? style.shadowColor : undefined;

	const toPctX = (px: number) => (stageW > 0 ? (px / stageW) * 100 : 0);
	const toPctY = (px: number) => (stageH > 0 ? (px / stageH) * 100 : 0);

	const handleDragEnd = (event: KonvaEvent<DragEvent>) => {
		const node = event.target;
		onChange({
			x: round(toPctX(node.x() - originX)),
			y: round(toPctY(node.y() - originY)),
		});
	};

	const handleTransformEnd = (event: KonvaEvent<Event>) => {
		const node = event.target;
		const scaleX = node.scaleX();
		const scaleY = node.scaleY();
		node.scaleX(1);
		node.scaleY(1);

		let nextW: number;
		let nextH: number;
		if (layer.type === "shape" && layer.shape === "ellipse") {
			const ellipse = node as Konva.Ellipse;
			nextW = ellipse.radiusX() * 2 * Math.abs(scaleX);
			nextH = ellipse.radiusY() * 2 * Math.abs(scaleY);
		} else {
			nextW = node.width() * Math.abs(scaleX);
			nextH = node.height() * Math.abs(scaleY);
		}

		onChange({
			x: round(toPctX(node.x() - originX * Math.abs(scaleX))),
			y: round(toPctY(node.y() - originY * Math.abs(scaleY))),
			width: round(toPctX(Math.max(2, nextW))),
			height: round(toPctY(Math.max(2, nextH))),
			style: { ...style, rotation: round(node.rotation(), 1) },
		});
	};

	const common = {
		x: posX,
		y: posY,
		offsetX: originX,
		offsetY: originY,
		opacity,
		rotation,
		draggable,
		listening,
		onMouseDown: listening ? onSelect : undefined,
		onTouchStart: listening ? onSelect : undefined,
		onDragStart: listening ? onSelect : undefined,
		onDragEnd: handleDragEnd,
		onTransformEnd: handleTransformEnd,
	};

	if (layer.type === "text") {
		const text = applyTextTransform(resolveText(layer, data, selection), style.textTransform);
		const hasBox = w !== undefined && h !== undefined;
		return (
			<Fragment>
				{style.fill && hasBox ? (
					<Rect
						x={posX}
						y={posY}
						offsetX={originX}
						offsetY={originY}
						width={w}
						height={h}
						rotation={rotation}
						opacity={opacity}
						fill={style.fill}
						cornerRadius={(style.radius ?? 0) * k}
						stroke={style.stroke && style.strokeWidth ? style.stroke : undefined}
						strokeWidth={(style.strokeWidth ?? 0) * k}
						listening={false}
						perfectDrawEnabled={false}
					/>
				) : null}
				<Text
					ref={registerRef}
					{...common}
					text={text}
					width={w}
					height={h}
					fontFamily={style.fontFamily ?? "Inter, Arial, sans-serif"}
					fontSize={(style.fontSize ?? 48) * k}
					fontStyle={fontStyleOf(style)}
					fill={style.color ?? "#ffffff"}
					align={style.align ?? "left"}
					verticalAlign={h !== undefined ? style.verticalAlign ?? "top" : undefined}
					lineHeight={style.lineHeight ?? 1.2}
					letterSpacing={(style.letterSpacing ?? 0) * k}
					padding={(style.padding ?? 0) * k}
					wrap={w === undefined ? "none" : "word"}
					stroke={style.textStrokeWidth ? style.textStrokeColor ?? "#000000" : undefined}
					strokeWidth={(style.textStrokeWidth ?? 0) * k}
					fillAfterStrokeEnabled
					shadowColor={shadowColor}
					shadowBlur={(style.shadowBlur ?? 0) * k}
					shadowOffsetX={(style.shadowOffsetX ?? 0) * k}
					shadowOffsetY={(style.shadowOffsetY ?? 0) * k}
					perfectDrawEnabled={false}
				/>
			</Fragment>
		);
	}

	if (layer.type === "shape") {
		const fill = style.fill === undefined ? "rgba(255,255,255,0.9)" : style.fill || "transparent";
		const stroke = style.stroke && style.strokeWidth ? style.stroke : undefined;
		const strokeWidth = (style.strokeWidth ?? 0) * k;

		if (layer.shape === "ellipse") {
			const radiusX = w !== undefined ? w / 2 : 60 * k;
			const radiusY = h !== undefined ? h / 2 : 60 * ky;
			return (
				<Ellipse
					ref={registerRef}
					{...common}
					x={(layer.x / 100) * stageW + radiusX}
					y={(layer.y / 100) * stageH + radiusY}
					offsetX={radiusX}
					offsetY={radiusY}
					radiusX={radiusX}
					radiusY={radiusY}
					fill={fill}
					stroke={stroke}
					strokeWidth={strokeWidth}
					shadowColor={shadowColor}
					shadowBlur={(style.shadowBlur ?? 0) * k}
					shadowOffsetX={(style.shadowOffsetX ?? 0) * k}
					shadowOffsetY={(style.shadowOffsetY ?? 0) * k}
					perfectDrawEnabled={false}
				/>
			);
		}

		return (
			<Rect
				ref={registerRef}
				{...common}
				width={w ?? 200}
				height={h ?? 80}
				fill={fill}
				cornerRadius={(style.radius ?? 0) * k}
				stroke={stroke}
				strokeWidth={strokeWidth}
				shadowColor={shadowColor}
				shadowBlur={(style.shadowBlur ?? 0) * k}
				shadowOffsetX={(style.shadowOffsetX ?? 0) * k}
				shadowOffsetY={(style.shadowOffsetY ?? 0) * k}
				perfectDrawEnabled={false}
			/>
		);
	}

	// video: a Konva.Image paints the paused frame; until one is available (no
	// src, still loading or a 404) a dashed placeholder keeps the layer visible
	// and selectable. Konva's hit area follows width/height, so an image-less
	// node is still clickable.
	if (layer.type === "video") {
		const boxW = w ?? 320 * k;
		const boxH = h ?? 180 * k;
		return (
			<Fragment>
				{!video ? (
					<Fragment>
						<Rect
							x={posX}
							y={posY}
							offsetX={originX}
							offsetY={originY}
							width={boxW}
							height={boxH}
							rotation={rotation}
							opacity={opacity}
							fill="rgba(74,168,255,0.06)"
							stroke="rgba(74,168,255,0.65)"
							strokeWidth={1}
							dash={[8, 6]}
							cornerRadius={(style.radius ?? 0) * k}
							listening={false}
							perfectDrawEnabled={false}
						/>
						<Text
							text={videoPlaceholderLabel(videoSrc)}
							x={posX - originX + 8}
							y={posY - originY + 8}
							width={Math.max(10, boxW - 16)}
							fontSize={12}
							fill="rgba(143,211,255,0.95)"
							listening={false}
						/>
					</Fragment>
				) : null}
				<KonvaImage
					ref={setVideoNode}
					{...common}
					image={video}
					width={boxW}
					height={boxH}
					cornerRadius={(style.radius ?? 0) * k}
					perfectDrawEnabled={false}
				/>
			</Fragment>
		);
	}

	// image / gif
	return (
		<KonvaImage
			ref={registerRef}
			{...common}
			image={image}
			width={w}
			height={h}
			cornerRadius={(style.radius ?? 0) * k}
			perfectDrawEnabled={false}
		/>
	);
}
