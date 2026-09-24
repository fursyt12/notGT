/**
 * notGT editor — the react-konva canvas.
 *
 * Layers are stored as percentages of the template's design box, so the whole
 * stage is rendered at `design * scale` and every pixel value is multiplied by
 * that scale; dragging / resizing converts straight back to percentages.
 */
import type Konva from "konva";
import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import {
	Ellipse,
	Image as KonvaImage,
	Layer as KonvaLayer,
	Line,
	Rect,
	Stage,
	Text,
	Transformer,
} from "react-konva";

import { interpolate } from "../../shared/binding";
import type { Layer, LayerStyle, TitleData, TitleTemplate } from "../../shared/types";
import { resolveAssetUrl, resolveText, round, useElementSize, useHtmlImage } from "./ui";

type KonvaEvent<T extends Event> = Konva.KonvaEventObject<T>;

export interface EditorCanvasProps {
	template: TitleTemplate;
	data: TitleData;
	selectedLayerId: string | null;
	onSelectLayer: (id: string | null) => void;
	onLayerChange: (id: string, patch: Partial<Layer>) => void;
}

export function EditorCanvas({
	template,
	data,
	selectedLayerId,
	onSelectLayer,
	onLayerChange,
}: EditorCanvasProps) {
	const { ref, width, height } = useElementSize<HTMLDivElement>();

	const designW = template.width > 0 ? template.width : 1920;
	const designH = template.height > 0 ? template.height : 1080;
	const availableW = Math.max(0, width - 24);
	const availableH = Math.max(0, height - 24);
	const fit = Math.min(availableW / designW, availableH / designH);
	const scale = Number.isFinite(fit) && fit > 0 ? fit : 0;

	const stageW = Math.max(1, Math.round(designW * scale));
	const stageH = Math.max(1, Math.round(designH * scale));
	const kx = stageW / designW;
	const ky = stageH / designH;

	const nodeRefs = useRef(new Map<string, Konva.Node>());
	const refSetters = useRef(new Map<string, (node: Konva.Node | null) => void>());
	const transformerRef = useRef<Konva.Transformer | null>(null);

	const nodeRefFor = useCallback((id: string) => {
		let setter = refSetters.current.get(id);
		if (!setter) {
			setter = (node: Konva.Node | null) => {
				if (node) nodeRefs.current.set(id, node);
				else nodeRefs.current.delete(id);
			};
			refSetters.current.set(id, setter);
		}
		return setter;
	}, []);

	const layers = useMemo(
		() => [...(template.layers ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)),
		[template.layers],
	);

	useEffect(() => {
		const transformer = transformerRef.current;
		if (!transformer) return;
		const node = selectedLayerId ? nodeRefs.current.get(selectedLayerId) : undefined;
		transformer.nodes(node ? [node] : []);
		transformer.getLayer()?.batchDraw();
	}, [selectedLayerId, layers, scale]);

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

	const selectedLayer = layers.find((layer) => layer.id === selectedLayerId) ?? null;

	return (
		<div className="ed-center">
			<div className="ed-canvas-wrap" ref={ref}>
				{scale > 0 ? (
					<div
						className="ed-canvas-stage"
						style={{ width: stageW, height: stageH }}
					>
						<Stage
							width={stageW}
							height={stageH}
							onMouseDown={(event: KonvaEvent<MouseEvent>) => {
								if (event.target === event.target.getStage()) onSelectLayer(null);
							}}
						>
							<KonvaLayer>
								<Rect
									x={0}
									y={0}
									width={stageW}
									height={stageH}
									fill="#0d141c"
									listening={false}
								/>
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

								{layers.map((layer) => (
									<LayerNode
										key={layer.id}
										layer={layer}
										data={data}
										stageW={stageW}
										stageH={stageH}
										k={kx}
										ky={ky}
										onSelect={() => onSelectLayer(layer.id)}
										onChange={(patch) => onLayerChange(layer.id, patch)}
										registerRef={nodeRefFor(layer.id)}
									/>
								))}

								<Transformer
									ref={transformerRef}
									rotateEnabled={!selectedLayer?.locked}
									resizeEnabled={!selectedLayer?.locked}
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
					Холст {designW}×{designH}
				</span>
				<span>Масштаб {Math.round(scale * 100)}%</span>
				<span>Слоёв: {layers.length}</span>
				{selectedLayer ? (
					<span className="ed-ok">
						{selectedLayer.name || selectedLayer.id}: x {round(selectedLayer.x)}% · y{" "}
						{round(selectedLayer.y)}%
					</span>
				) : (
					<span>Клик — выбрать слой · стрелки — сдвиг · Shift+стрелки — крупный шаг</span>
				)}
			</div>
		</div>
	);
}

// --------------------------------------------------------------- layer nodes

interface LayerNodeProps {
	layer: Layer;
	data: TitleData;
	stageW: number;
	stageH: number;
	k: number;
	ky: number;
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

function LayerNode({
	layer,
	data,
	stageW,
	stageH,
	k,
	ky,
	onSelect,
	onChange,
	registerRef,
}: LayerNodeProps) {
	const style: LayerStyle = layer.style ?? {};
	const isImage = layer.type === "image" || layer.type === "gif";
	const rawSrc = isImage ? resolveAssetUrl(interpolate(layer.src ?? "", data)) : "";
	const image = useHtmlImage(rawSrc);

	// --- geometry (percent -> stage px)
	let w: number | undefined;
	let h: number | undefined;
	if (layer.width !== undefined) w = (layer.width / 100) * stageW;
	else if (isImage && image) w = (image.naturalWidth || image.width) * k;
	if (layer.height !== undefined) h = (layer.height / 100) * stageH;
	else if (isImage && image) h = (image.naturalHeight || image.height) * ky;

	// Konva rotates/scales around (offsetX, offsetY); matching CSS means using
	// the box centre whenever we know the box.
	const originX = w !== undefined ? w / 2 : 0;
	const originY = h !== undefined ? h / 2 : 0;
	const posX = (layer.x / 100) * stageW + originX;
	const posY = (layer.y / 100) * stageH + originY;

	const opacity = layer.hidden ? 0.25 : style.opacity ?? 1;
	const rotation = style.rotation ?? 0;
	const interactive = !layer.locked && !layer.hidden;
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
		draggable: interactive,
		listening: !layer.hidden,
		onMouseDown: onSelect,
		onTouchStart: onSelect,
		onDragStart: onSelect,
		onDragEnd: handleDragEnd,
		onTransformEnd: handleTransformEnd,
	};

	if (layer.type === "text") {
		const text = applyTextTransform(resolveText(layer, data), style.textTransform);
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
