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
import {
	Fragment,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
import { useCodeDocument } from "./code-preview";
import {
	type SnapLine,
	layerSnapLines,
	placementSnapLines,
	snapBox,
} from "./snapping";

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
	/** Live playback preview: only the selected video layer is played. */
	previewPlaying: boolean;
	/** Incremented to seek the selected clip back to 0. */
	restartToken: number;
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

/** Anything drawn at a template's design box on the stage: a placement or the
 *  preview of the template being edited. */
interface PreviewBox {
	template: TitleTemplate;
	/** Placement box on the stage, in stage px. */
	boxX: number;
	boxY: number;
	boxW: number;
	boxH: number;
	/** Design px -> stage px factor. */
	k: number;
}

const noop = () => {};
const noopRef = () => {};

/** How close (in screen px) a box has to come to a line to stick to it. */
const SNAP_THRESHOLD_PX = 7;
/** Remembers the magnet switch between dashboard reloads. */
const SNAP_STORAGE_KEY = "notgt.editor.snapping";

/**
 * Snapping available to everything draggable on the stage.
 *
 * The two kinds of drag live in different coordinate spaces — a placement moves
 * inside the out's stage, a layer moves inside its template's box — so they get
 * their own line sets, and the guides are published per space too.
 */
interface SnapApi {
	enabled: boolean;
	/** In stage px: the caller divides the screen threshold by the camera zoom. */
	threshold: number;
	/** Lines for moving a whole placement, in stage px. */
	placementX: SnapLine[];
	placementY: SnapLine[];
	/** Lines for moving a layer, in the template's own px. */
	layerX: SnapLine[];
	layerY: SnapLine[];
	showPlacement: (x: number[], y: number[]) => void;
	showLayer: (x: number[], y: number[]) => void;
	clear: () => void;
}

const SnapContext = createContext<SnapApi | null>(null);

export function EditorCanvas({
	out,
	templates,
	draft,
	activeItemId,
	selectedLayerId,
	previewPlaying,
	restartToken,
	data,
	selection,
	onSelectItem,
	onSelectLayer,
	onLayerChange,
	onItemChange,
}: EditorCanvasProps) {
	const { ref, width, height } = useElementSize<HTMLDivElement>();

	// Camera state: position (pan) and scale (zoom)
	const [cameraX, setCameraX] = useState(0);
	const [cameraY, setCameraY] = useState(0);
	const [cameraScale, setCameraScale] = useState(1);
	const isPanning = useRef(false);
	const lastMousePos = useRef({ x: 0, y: 0 });

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

	/**
	 * The template being edited, when it is not placed on the out shown here.
	 *
	 * The stage draws placements, so selecting an animation in the library — a
	 * built-in example, a new code animation, anything not on this out — used to
	 * leave the canvas empty and say nothing about the code open in the panel
	 * next to it. Drawing the draft centred at its design size makes "what I
	 * edit" and "what I see" the same thing again; the frame and the caption say
	 * that this is the template, not a placement.
	 */
	const draftBox = useMemo<PreviewBox | null>(() => {
		if (!draft || fit <= 0) return null;
		if (geoms.some((geom) => geom.template.id === draft.id)) return null;
		const boxW = Math.max(1, draft.width * fit);
		const boxH = Math.max(1, draft.height * fit);
		return {
			template: draft,
			boxX: Math.max(0, (stageW - boxW) / 2),
			boxY: Math.max(0, (stageH - boxH) / 2),
			boxW,
			boxH,
			k: fit,
		};
	}, [draft, geoms, fit, stageW, stageH]);

	// --- magnetic snapping -------------------------------------------------
	const [snapEnabled, setSnapEnabled] = useState(() => {
		try {
			return localStorage.getItem(SNAP_STORAGE_KEY) !== "0";
		} catch {
			return true;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(SNAP_STORAGE_KEY, snapEnabled ? "1" : "0");
		} catch {
			// A dashboard with storage disabled simply forgets the preference.
		}
	}, [snapEnabled]);

	/** Lines drawn while a drag is in progress, in stage px. */
	const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
	const clearGuides = useCallback(() => setGuides({ x: [], y: [] }), []);

	const placementLines = useMemo(
		() =>
			placementSnapLines(
				stageW,
				stageH,
				geoms.filter((geom) => geom.item.id !== activeItemId),
			),
		[geoms, activeItemId, stageW, stageH],
	);

	/** Layer lines are in the active template's own px, so they only exist for it. */
	const layerLines = useMemo(() => {
		if (!activeGeom || activeGeom.template.kind !== "layers") return { x: [], y: [] };
		return layerSnapLines(
			activeGeom.template.width,
			activeGeom.template.height,
			activeGeom.k,
			activeGeom.template.layers ?? [],
			selectedLayerId,
		);
	}, [activeGeom, selectedLayerId]);

	const snapApi = useMemo<SnapApi>(
		() => ({
			enabled: snapEnabled && fit > 0,
			// The camera scales the stage content, so a threshold that feels the
			// same at every zoom is a screen distance divided by that zoom.
			threshold: SNAP_THRESHOLD_PX / Math.max(0.01, cameraScale),
			placementX: placementLines.x,
			placementY: placementLines.y,
			layerX: layerLines.x,
			layerY: layerLines.y,
			showPlacement: (x, y) => setGuides({ x, y }),
			showLayer: (x, y) =>
				setGuides({
					x: x.map((value) => (activeGeom ? activeGeom.boxX + value : value)),
					y: y.map((value) => (activeGeom ? activeGeom.boxY + value : value)),
				}),
			clear: clearGuides,
		}),
		[snapEnabled, fit, cameraScale, placementLines, layerLines, activeGeom, clearGuides],
	);

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

	// Mouse wheel zoom handler
	const handleWheel = useCallback(
		(e: KonvaEvent<WheelEvent>) => {
			e.evt.preventDefault();
			const stage = e.target.getStage();
			if (!stage) return;

			const oldScale = cameraScale;
			const pointer = stage.getPointerPosition();
			if (!pointer) return;

			// Zoom factor: wheel down = zoom out, wheel up = zoom in
			const scaleBy = 1.05;
			const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
			const clampedScale = Math.max(0.1, Math.min(5, newScale));

			// Calculate new camera position to zoom towards cursor
			const mousePointTo = {
				x: (pointer.x - cameraX) / oldScale,
				y: (pointer.y - cameraY) / oldScale,
			};

			const newX = pointer.x - mousePointTo.x * clampedScale;
			const newY = pointer.y - mousePointTo.y * clampedScale;

			setCameraScale(clampedScale);
			setCameraX(newX);
			setCameraY(newY);
		},
		[cameraScale, cameraX, cameraY],
	);

	// Mouse pan handlers (middle button)
	const handleMouseDown = useCallback((e: KonvaEvent<MouseEvent>) => {
		if (e.evt.button === 1) {
			// Middle mouse button
			e.evt.preventDefault();
			isPanning.current = true;
			lastMousePos.current = { x: e.evt.clientX, y: e.evt.clientY };
		}
	}, []);

	const handleMouseMove = useCallback(
		(e: KonvaEvent<MouseEvent>) => {
			if (!isPanning.current) return;

			const dx = e.evt.clientX - lastMousePos.current.x;
			const dy = e.evt.clientY - lastMousePos.current.y;

			setCameraX((prev) => prev + dx);
			setCameraY((prev) => prev + dy);

			lastMousePos.current = { x: e.evt.clientX, y: e.evt.clientY };
		},
		[],
	);

	const handleMouseUp = useCallback((e: KonvaEvent<MouseEvent>) => {
		if (e.evt.button === 1) {
			isPanning.current = false;
		}
	}, []);

	// Global mouse up listener for when mouse leaves canvas while panning
	useEffect(() => {
		const globalMouseUp = () => {
			isPanning.current = false;
		};
		window.addEventListener("mouseup", globalMouseUp);
		return () => window.removeEventListener("mouseup", globalMouseUp);
	}, []);

	// Reset camera when out changes
	useEffect(() => {
		setCameraX(0);
		setCameraY(0);
		setCameraScale(1);
	}, [out.id]);

	// Reset camera manually
	const resetCamera = useCallback(() => {
		setCameraX(0);
		setCameraY(0);
		setCameraScale(1);
	}, []);

	const stageSummary = `${designW}×${designH} · анимаций ${geoms.length}`;

	return (
		<SnapContext.Provider value={snapApi}>
			<div className="ed-center">
			<div className="ed-canvas-wrap" ref={ref}>
				{fit > 0 ? (
					<div className="ed-canvas-stage" style={{ width: stageW, height: stageH }}>
						{/* Code animations are live iframes, and Konva cannot host one,
						    so they are painted as DOM *under* the stage: the canvas
						    stays on top and keeps drawing the frames, handles and
						    selection around them. The overlay carries the same camera
						    transform as the stage, so a preview sits exactly on its
						    placement. */}
						<div
							className="ed-code-overlay"
							style={{
								transform: `translate(${cameraX}px, ${cameraY}px) scale(${cameraScale})`,
							}}
						>
							{geoms
								.filter((geom) => geom.template.kind === "code")
								.map((geom) => (
									<CodeOverlayFrame
										key={geom.item.id}
										box={geom}
										dim={
											geom.item.id === activeItemId
												? 1
												: geom.item.enabled === false
													? 0.22
													: 0.45
										}
										data={data}
									/>
								))}
							{draftBox && draftBox.template.kind === "code" ? (
								<CodeOverlayFrame box={draftBox} dim={1} data={data} />
							) : null}
						</div>

						<Stage
							width={stageW}
							height={stageH}
							scaleX={cameraScale}
							scaleY={cameraScale}
							x={cameraX}
							y={cameraY}
							onWheel={handleWheel}
							onMouseDown={(event: KonvaEvent<MouseEvent>) => {
								if (event.evt.button === 1) {
									handleMouseDown(event);
									return;
								}
								if (event.target === event.target.getStage()) {
									onSelectItem(null);
									onSelectLayer(null);
								}
							}}
							onMouseMove={handleMouseMove}
							onMouseUp={handleMouseUp}
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
										previewPlaying={previewPlaying}
										restartToken={restartToken}
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

							{/* The template being edited, when it is not placed on this
							    out: read-only, only so that the code open in the panel
							    next to the canvas is also visible on the canvas. */}
							{draftBox ? (
								<KonvaLayer listening={false}>
									<Group x={draftBox.boxX} y={draftBox.boxY}>
										{draftBox.template.kind === "code"
											? null
											: sortByZ(draftBox.template.layers ?? []).map((layer) => (
													<LayerNode
														key={`draft:${layer.id}`}
														layer={layer}
														data={data}
														selection={selection}
														stageW={draftBox.template.width * draftBox.k}
														stageH={draftBox.template.height * draftBox.k}
														k={draftBox.k}
														ky={draftBox.k}
														interactive={false}
														listening={false}
														playing={false}
														restartToken={0}
														onSelect={noop}
														onChange={noop}
														registerRef={noopRef}
													/>
												))}
										<Rect
											width={draftBox.boxW}
											height={draftBox.boxH}
											stroke="rgba(178,140,255,0.85)"
											strokeWidth={1}
											dash={[10, 6]}
											listening={false}
										/>
										<Text
											text={`Предпросмотр шаблона «${draftBox.template.name}» — на этом out'е его нет`}
											x={12}
											y={12}
											width={Math.max(10, draftBox.boxW - 24)}
											fontSize={14}
											fill="rgba(205,180,255,0.95)"
											listening={false}
										/>
									</Group>
								</KonvaLayer>
							) : null}

							{/* Snap guides, drawn last so they stay visible over every
							    animation while something is being dragged. */}
							{guides.x.length > 0 || guides.y.length > 0 ? (
								<KonvaLayer listening={false}>
									{guides.x.map((x, index) => (
										<Line
											key={`gx${index}`}
											points={[x, 0, x, stageH]}
											stroke="rgba(255,77,210,0.95)"
											strokeWidth={1}
											dash={[6, 4]}
										/>
									))}
									{guides.y.map((y, index) => (
										<Line
											key={`gy${index}`}
											points={[0, y, stageW, y]}
											stroke="rgba(255,77,210,0.95)"
											strokeWidth={1}
											dash={[6, 4]}
										/>
									))}
								</KonvaLayer>
							) : null}
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
				<span>Масштаб {Math.round(fit * 100)}% · Зум {Math.round(cameraScale * 100)}%</span>
				<label className="ed-snap" title="Притягивать к центру и краям out'а, безопасной зоне и другим анимациям">
					<input
						type="checkbox"
						checked={snapEnabled}
						onChange={(event) => setSnapEnabled(event.target.checked)}
					/>
					магниты
				</label>
				{(cameraScale !== 1 || cameraX !== 0 || cameraY !== 0) ? (
					<button
						type="button"
						className="ed-mini"
						style={{ padding: "1px 6px", fontSize: "10px" }}
						onClick={resetCamera}
						title="Сбросить вид (вернуть зум и положение)"
					>
						↺ Сбросить вид
					</button>
				) : null}
				{activeGeom ? (
					<span className="ed-ok">
						{activeGeom.template.name}: x {round(activeGeom.item.x)}% · y{" "}
						{round(activeGeom.item.y)}% · scale {round(activeGeom.scale, 3)}
					</span>
				) : (
					<span>
						Клик — выбрать · средняя кнопка — перемещение · колесо — зум
					</span>
				)}
			</div>
			</div>
		</SnapContext.Provider>
	);
}

// -------------------------------------------------------------- one animation

/**
 * Dragging a whole placement.
 *
 * The node moves as a delta inside the placement's group, so the drag becomes
 * new `x`/`y` percentages only on release; the magnets correct that delta while
 * the drag is in flight, and the guides show what it stuck to.
 */
function usePlacementDrag(
	geom: Geometry,
	stageW: number,
	stageH: number,
	onItemChange: (itemId: string, patch: Partial<OutItem>) => void,
): {
	onDragMove: (event: KonvaEvent<DragEvent>) => void;
	onDragEnd: (event: KonvaEvent<DragEvent>) => void;
} {
	const snap = useContext(SnapContext);
	const { item, boxX, boxY, boxW, boxH } = geom;

	const onDragMove = (event: KonvaEvent<DragEvent>) => {
		const node = event.target;
		if (!snap?.enabled) return;
		const moved = snapBox(
			{ x: boxX + node.x(), y: boxY + node.y(), width: boxW, height: boxH },
			snap.placementX,
			snap.placementY,
			snap.threshold,
		);
		node.position({ x: moved.box.x - boxX, y: moved.box.y - boxY });
		snap.showPlacement(moved.guidesX, moved.guidesY);
	};

	const onDragEnd = (event: KonvaEvent<DragEvent>) => {
		const node = event.target;
		snap?.clear();
		onItemChange(item.id, {
			x: round((item.x ?? 0) + (stageW > 0 ? (node.x() / stageW) * 100 : 0)),
			y: round((item.y ?? 0) + (stageH > 0 ? (node.y() / stageH) * 100 : 0)),
		});
		node.position({ x: 0, y: 0 });
	};

	return { onDragMove, onDragEnd };
}

function AnimatedItem({
	geom,
	stageW,
	stageH,
	active,
	selectedLayerId,
	previewPlaying,
	restartToken,
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
	previewPlaying: boolean;
	restartToken: number;
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

	const placementDrag = usePlacementDrag(geom, stageW, stageH, onItemChange);

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
					onDragMove={placementDrag.onDragMove}
					onDragEnd={placementDrag.onDragEnd}
				/>
			) : null}

			{template.kind === "code" ? (
				<CodePlaceholder boxW={boxW} boxH={boxH} />
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
						playing={previewPlaying && active && layer.id === selectedLayerId}
						restartToken={restartToken}
						onSelect={() => onSelectLayer(layer.id)}
						onChange={(patch) => onLayerChange(layer.id, patch)}
						registerRef={registerRef(item.id, layer.id)}
					/>
				))
			)}
		</Group>
	);
}

/**
 * Outline of a code placement. The animation itself is the live iframe in the
 * DOM overlay above; this frame only keeps the box readable when the animation
 * is transparent where it is empty.
 */
function CodePlaceholder({ boxW, boxH }: { boxW: number; boxH: number }) {
	return (
		<Rect
			width={boxW}
			height={boxH}
			stroke="rgba(255,190,90,0.45)"
			strokeWidth={1}
			dash={[8, 6]}
			listening={false}
		/>
	);
}

/**
 * One code animation on the canvas: its document rendered live in an iframe,
 * scaled from the template's design size down to the placement box. Pointer
 * events stay off so the canvas underneath keeps receiving drags and clicks.
 */
function CodeOverlayFrame({
	box,
	dim,
	data,
}: {
	box: PreviewBox;
	dim: number;
	data: TitleData;
}) {
	const doc = useCodeDocument(box.template, data);
	return (
		<div
			className="ed-code-overlay__box"
			style={{
				left: box.boxX,
				top: box.boxY,
				width: box.boxW,
				height: box.boxH,
				opacity: dim,
			}}
		>
			<iframe
				title={`${box.template.name} — предпросмотр на холсте`}
				sandbox="allow-scripts allow-same-origin"
				srcDoc={doc}
				style={{
					width: box.template.width,
					height: box.template.height,
					transform: `scale(${box.k})`,
				}}
			/>
		</div>
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
	const placementDrag = usePlacementDrag(geom, stageW, stageH, onItemChange);

	return (
		<Group x={boxX} y={boxY}>
			{/* Move handle (top-left). */}
			<Group
				x={0}
				y={0}
				draggable
				onDragMove={placementDrag.onDragMove}
				onDragEnd={placementDrag.onDragEnd}
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
	/** Live preview is running for *this* video layer. */
	playing: boolean;
	/** Seek-to-zero token forwarded to `useHtmlVideo`. */
	restartToken: number;
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
	playing,
	restartToken,
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
		// The editor preview is always silent, whatever `videoMuted` says — an
		// operator panel must never make noise. The stored value is untouched.
		muted: true,
		rate: style.videoRate ?? 1,
		playing,
		restartToken,
	});

	// Konva does not watch the element: force a redraw on every decoded picture
	// event and on every animation frame while the preview is playing.
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
	const snap = useContext(SnapContext);
	const shadowColor = style.shadowColor ? style.shadowColor : undefined;

	const toPctX = (px: number) => (stageW > 0 ? (px / stageW) * 100 : 0);
	const toPctY = (px: number) => (stageH > 0 ? (px / stageH) * 100 : 0);

	const handleDragEnd = (event: KonvaEvent<DragEvent>) => {
		const node = event.target;
		snap?.clear();
		onChange({
			x: round(toPctX(node.x() - originX)),
			y: round(toPctY(node.y() - originY)),
		});
	};

	/**
	 * Snaps a layer to the template's box and to its sibling layers. Rotated
	 * layers are left alone: their box is the rotated one, and pretending
	 * otherwise would snap to coordinates the operator cannot see.
	 */
	const handleDragMove = (event: KonvaEvent<DragEvent>) => {
		const node = event.target;
		if (!snap?.enabled || rotation !== 0 || w === undefined || h === undefined) return;
		const moved = snapBox(
			{ x: node.x() - originX, y: node.y() - originY, width: w, height: h },
			snap.layerX,
			snap.layerY,
			snap.threshold,
		);
		node.position({ x: moved.box.x + originX, y: moved.box.y + originY });
		snap.showLayer(moved.guidesX, moved.guidesY);
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
		onDragMove: handleDragMove,
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
