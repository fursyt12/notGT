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
import { cropBox, cropIsFull, fullCrop, roundCrop, MIN_CROP_PX } from "../../shared/crop";
import type {
	ItemCrop,
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
	clamp,
	round,
	sortByZ,
	useElementSize,
	useHtmlImage,
	useHtmlVideo,
} from "./ui";
import { useCodeDocument } from "./code-preview";
import {
	type SnapBox,
	type SnapLine,
	boxSnapLines,
	layerSnapLines,
	placementSnapLines,
	snapBox,
	snapCoordinate,
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
	/** The crop tool is active: the placement is edited, not played with. */
	cropMode: boolean;
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

/** A point in stage px (the out's design box scaled by `fit`). */
interface Point {
	x: number;
	y: number;
}

/**
 * What is changing *right now*, before anything is saved.
 *
 * A drag used to move only the Konva node it started on, so the rest of the
 * placement — the layers of the box, the live iframe of a code animation — sat
 * still until the mouse was released and the new percentages reached the
 * replicant. The preview is that movement while it happens: the canvas renders
 * every placement from `geom` plus this offset, so what the operator drags is
 * what the operator sees, and the replicant is written once, on release.
 */
interface DragPreview {
	itemId: string;
	/** Placement offset in stage px. */
	dx: number;
	dy: number;
	/** Placement scale while the size handle is being dragged. */
	scale?: number;
	/** Crop window in template px while the crop frame is being dragged. */
	crop?: ItemCrop;
}

/**
 * Pointer plumbing shared by every handle on the canvas.
 *
 * Konva's own `draggable` moves the node it was started on, which is exactly
 * what we do not want (the node is only one part of a placement), so the
 * handles drag themselves: a mousedown starts a window-level move/up pair, and
 * `pointOf` turns a pointer event into stage coordinates, camera and all.
 */
interface DragApi {
	preview: DragPreview | null;
	setPreview: (next: DragPreview | null) => void;
	/** Stage coordinates of a pointer event. */
	pointOf: (event: MouseEvent) => Point | null;
	/** Starts a drag; the handlers receive stage coordinates. */
	begin: (
		event: KonvaEvent<MouseEvent>,
		move: (point: Point) => void,
		end: (point: Point) => void,
	) => void;
	/** The geometry as it should be drawn right now (preview applied). */
	view: (geom: Geometry) => Geometry;
}

const DragContext = createContext<DragApi | null>(null);

export function EditorCanvas({
	out,
	templates,
	draft,
	activeItemId,
	selectedLayerId,
	cropMode,
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
	const stageRef = useRef<Konva.Stage | null>(null);

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

	// --- live drag preview -------------------------------------------------
	const [preview, setPreview] = useState<DragPreview | null>(null);

	/** Stage px of a pointer event: container px, camera undone. */
	const pointOf = useCallback(
		(event: MouseEvent): Point | null => {
			const container = stageRef.current?.container();
			if (!container) return null;
			const rect = container.getBoundingClientRect();
			return {
				x: (event.clientX - rect.left - cameraX) / cameraScale,
				y: (event.clientY - rect.top - cameraY) / cameraScale,
			};
		},
		[cameraX, cameraY, cameraScale],
	);

	/**
	 * Drags until the mouse button comes up, wherever the pointer goes.
	 *
	 * The handlers get stage coordinates, so a drag keeps working when it leaves
	 * the canvas, and nothing depends on the node that was pressed.
	 */
	const begin = useCallback(
		(
			event: KonvaEvent<MouseEvent>,
			move: (point: Point) => void,
			end: (point: Point) => void,
		) => {
			if (event.evt.button !== 0) return;
			const start = pointOf(event.evt);
			if (!start) return;
			event.cancelBubble = true;
			event.evt.preventDefault();
			const onMove = (native: MouseEvent) => {
				const point = pointOf(native);
				if (point) move(point);
			};
			const onUp = (native: MouseEvent) => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				end(pointOf(native) ?? start);
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		},
		[pointOf],
	);

	/** The geometry as it must be drawn while a drag is in flight. */
	const withPreview = useCallback(
		(geom: Geometry): Geometry => {
			if (!preview || preview.itemId !== geom.item.id) return geom;
			const scale = preview.scale && preview.scale > 0 ? preview.scale : geom.scale;
			const k = scale * fit;
			return {
				...geom,
				scale,
				k,
				boxX: geom.boxX + preview.dx,
				boxY: geom.boxY + preview.dy,
				boxW: Math.max(1, geom.template.width * k),
				boxH: Math.max(1, geom.template.height * k),
			};
		},
		[preview, fit],
	);

	const dragApi = useMemo<DragApi>(
		() => ({ preview, setPreview, pointOf, begin, view: withPreview }),
		[preview, pointOf, begin, withPreview],
	);

	// A new selection, another out or another tool: nothing is being dragged.
	useEffect(() => {
		setPreview(null);
	}, [activeItemId, out.id, cropMode]);

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
	/** The active placement as it is drawn right now (drag preview included). */
	const shownActive = activeGeom ? withPreview(activeGeom) : null;
	const activePending = Boolean(preview && activeGeom && preview.itemId === activeGeom.item.id);
	/** The visible window of the active placement, when it hides something. */
	const activeCrop =
		activeGeom && !cropIsFull(cropFor(activeGeom, preview), activeGeom.template)
			? cropFor(activeGeom, preview)
			: null;

	return (
		<SnapContext.Provider value={snapApi}>
			<DragContext.Provider value={dragApi}>
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
										box={withPreview(geom)}
										crop={cropFor(geom, preview)}
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
							ref={stageRef}
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
								    through its own frame. Only the visible window answers, so a
								    cropped animation is not selected from its hidden half. */}
								{geoms
									.filter((geom) => geom.item.id !== activeItemId)
									.map((geom) => {
										const win = windowOf(geom, cropFor(geom, preview));
										return (
											<Rect
												key={`catcher:${geom.item.id}`}
												x={win.x}
												y={win.y}
												width={win.width}
												height={win.height}
												fill="rgba(0,0,0,0.001)"
												onMouseDown={(event: KonvaEvent<MouseEvent>) => {
													event.cancelBubble = true;
													onSelectItem(geom.item.id);
													onSelectLayer(null);
												}}
											/>
										);
									})}

								{geoms.map((geom) => (
									<AnimatedItem
										key={geom.item.id}
										geom={geom}
										stageW={stageW}
										stageH={stageH}
										active={geom.item.id === activeItemId}
										cropMode={cropMode}
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
								    active animation sits below a later one. The crop tool
								    replaces them: while it is on, the frame is the thing being
								    edited. */}
								{activeGeom && !cropMode ? (
									<PlacementHandles
										geom={activeGeom}
										stageW={stageW}
										stageH={stageH}
										onItemChange={onItemChange}
									/>
								) : null}
								{activeGeom && cropMode ? (
									<CropOverlay
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
				{activeGeom && shownActive ? (
					<span className="ed-ok">
						{activeGeom.template.name}: x {round((shownActive.boxX / stageW) * 100)}% · y{" "}
						{round((shownActive.boxY / stageH) * 100)}% · scale{" "}
						{round(shownActive.scale, 3)}
						{activeCrop
							? ` · обрезка ${Math.round(activeCrop.width)}×${Math.round(
									activeCrop.height,
								)}`
							: ""}
						{activePending ? " · перетаскивание" : ""}
					</span>
				) : (
					<span>
						Клик — выбрать · средняя кнопка — перемещение · колесо — зум
					</span>
				)}
			</div>
			</div>
			</DragContext.Provider>
		</SnapContext.Provider>
	);
}

// -------------------------------------------------------------- one animation

/**
 * Dragging a whole placement.
 *
 * Nothing on the placement moves by itself: the drag publishes an offset into
 * the shared preview, every part of the placement (layers, live code iframe,
 * frame, handles) is drawn with it, and the magnets correct it on the way. The
 * new `x`/`y` percentages are written once, when the button comes up.
 */
function usePlacementDrag(
	geom: Geometry,
	stageW: number,
	stageH: number,
	onItemChange: (itemId: string, patch: Partial<OutItem>) => void,
): (event: KonvaEvent<MouseEvent>) => void {
	const snap = useContext(SnapContext);
	const drag = useContext(DragContext);
	const { item, boxX, boxY, boxW, boxH } = geom;

	return useCallback(
		(event: KonvaEvent<MouseEvent>) => {
			if (!drag) return;
			const start = drag.pointOf(event.evt);
			if (!start) return;
			let last = { x: boxX, y: boxY };
			drag.begin(
				event,
				(point) => {
					const raw = {
						x: boxX + (point.x - start.x),
						y: boxY + (point.y - start.y),
						width: boxW,
						height: boxH,
					};
					const moved =
						snap?.enabled
							? snapBox(raw, snap.placementX, snap.placementY, snap.threshold)
							: { box: raw, guidesX: [], guidesY: [] };
					last = { x: moved.box.x, y: moved.box.y };
					drag.setPreview({
						itemId: item.id,
						dx: last.x - boxX,
						dy: last.y - boxY,
					});
					snap?.showPlacement(moved.guidesX, moved.guidesY);
				},
				() => {
					drag.setPreview(null);
					snap?.clear();
					const dx = last.x - boxX;
					const dy = last.y - boxY;
					if (dx === 0 && dy === 0) return;
					onItemChange(item.id, {
						x: round((item.x ?? 0) + (stageW > 0 ? (dx / stageW) * 100 : 0)),
						y: round((item.y ?? 0) + (stageH > 0 ? (dy / stageH) * 100 : 0)),
					});
				},
			);
		},
		[snap, drag, item, boxX, boxY, boxW, boxH, stageW, stageH, onItemChange],
	);
}

function AnimatedItem({
	geom,
	stageW,
	stageH,
	active,
	cropMode,
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
	cropMode: boolean;
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
	const { item, template } = geom;
	const drag = useContext(DragContext);
	const view = drag ? drag.view(geom) : geom;
	const crop = cropFor(geom, drag?.preview ?? null);
	const cropped = !cropIsFull(crop, template);
	// Everything inside the group is drawn in the template's own box, so the
	// crop window is a local rectangle and the clip is one line.
	const local = {
		x: cropped ? crop.x * view.k : 0,
		y: cropped ? crop.y * view.k : 0,
		width: cropped ? Math.max(1, crop.width * view.k) : view.boxW,
		height: cropped ? Math.max(1, crop.height * view.k) : view.boxH,
	};
	const interactive = active && item.enabled !== false;
	const dim = active ? 1 : item.enabled === false ? 0.22 : 0.45;

	const onPlacementDown = usePlacementDrag(geom, stageW, stageH, onItemChange);

	// In crop mode the placement is a picture to cut, not a thing to move.
	const hitDown = (event: KonvaEvent<MouseEvent>) => {
		if (cropMode) {
			event.cancelBubble = true;
			return;
		}
		onSelectItem(item.id);
		onSelectLayer(null);
		onPlacementDown(event);
	};

	return (
		<Group
			x={view.boxX}
			y={view.boxY}
			opacity={dim}
			// A crop hides what sticks out of the window, the same way the out
			// page clips it with `overflow: hidden`.
			clipX={cropped ? local.x : undefined}
			clipY={cropped ? local.y : undefined}
			clipWidth={cropped ? local.width : undefined}
			clipHeight={cropped ? local.height : undefined}
		>
			{/* Placement frame: transparent hit area behind the layers, so dragging
			    an empty part of the box moves the whole animation. Only the visible
			    window answers, so a cropped animation is not grabbed by its hidden
			    half. */}
			{active ? (
				<Rect
					x={local.x}
					y={local.y}
					width={local.width}
					height={local.height}
					fill="rgba(0,0,0,0.001)"
					hitStrokeWidth={14}
					onMouseDown={hitDown}
				/>
			) : null}

			{template.kind === "code" ? (
				<CodePlaceholder boxW={view.boxW} boxH={view.boxH} />
			) : (
				sortByZ(template.layers ?? []).map((layer) => (
					<LayerNode
						key={layer.id}
						layer={layer}
						data={data}
						selection={selection}
						stageW={template.width * view.k}
						stageH={template.height * view.k}
						k={view.k}
						ky={view.k}
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
 *
 * A crop shrinks the outer box to the visible window and pulls the iframe back
 * by the same offset, so the animation keeps its place on screen and only the
 * part outside the window is cut away — the editor shows exactly what the out
 * page does.
 */
function CodeOverlayFrame({
	box,
	crop,
	dim,
	data,
}: {
	box: PreviewBox;
	/** Visible window in template px; absent = the whole box (the draft). */
	crop?: ItemCrop;
	dim: number;
	data: TitleData;
}) {
	const doc = useCodeDocument(box.template, data);
	const window_ = crop ?? fullCrop(box.template);
	return (
		<div
			className="ed-code-overlay__box"
			style={{
				left: box.boxX + window_.x * box.k,
				top: box.boxY + window_.y * box.k,
				width: Math.max(1, window_.width * box.k),
				height: Math.max(1, window_.height * box.k),
				opacity: dim,
			}}
		>
			{/* An iframe created with an empty `srcdoc` and filled in a moment
			    later occasionally keeps its about:blank and never paints, so it
			    is only created once there is a document to show. */}
			{doc ? (
				<iframe
					title={`${box.template.name} — предпросмотр на холсте`}
					sandbox="allow-scripts allow-same-origin"
					srcDoc={doc}
					style={{
						width: box.template.width,
						height: box.template.height,
						left: -window_.x * box.k,
						top: -window_.y * box.k,
						transform: `scale(${box.k})`,
					}}
				/>
			) : null}
		</div>
	);
}

// --------------------------------------------------------------- move + scale

/**
 * The frame around the active placement, the move handle in its top-left corner
 * and the size handle in its bottom-right.
 *
 * The frame is the *visible window* (the crop when there is one) — that is the
 * box the operator thinks in, and everything else measures from it. With a crop
 * the full template box is drawn faintly as well, so it is clear how much of the
 * animation is hidden.
 *
 * Both handles drag themselves (see `DragApi`): the move handle publishes an
 * offset, the size handle publishes a scale, and by the time the button comes up
 * the canvas has already been showing the result.
 */
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
	const drag = useContext(DragContext);
	const { item, template } = geom;
	const crop = cropFor(geom, drag?.preview ?? null);
	const view = drag ? drag.view(geom) : geom;
	const win = windowOf(view, crop);
	const onPlacementDown = usePlacementDrag(geom, stageW, stageH, onItemChange);
	const fit = fitOf(geom);

	/**
	 * Resizing keeps the window's top-left corner where it is: the scale changes
	 * the crop's offset inside the box too, so the placement has to move back by
	 * exactly that much or the title would crawl away from the corner the
	 * operator grabbed.
	 */
	const onSizeDown = (event: KonvaEvent<MouseEvent>) => {
		if (!drag) return;
		const start = drag.pointOf(event.evt);
		if (!start) return;
		const anchorX = win.x;
		const designW = crop.width > 0 ? crop.width : template.width;
		const baseK = geom.k;
		let scale = geom.scale;
		drag.begin(
			event,
			(point) => {
				scale = clamp((point.x - anchorX) / (designW * fit), 0.02, 20);
				const k = scale * fit;
				drag.setPreview({
					itemId: item.id,
					dx: -(crop.x * k - crop.x * baseK),
					dy: -(crop.y * k - crop.y * baseK),
					scale,
				});
			},
			() => {
				drag.setPreview(null);
				const k = scale * fit;
				onItemChange(item.id, {
					scale: round(scale, 4),
					x: round(
						(item.x ?? 0) -
							(stageW > 0 ? ((crop.x * k - crop.x * baseK) / stageW) * 100 : 0),
					),
					y: round(
						(item.y ?? 0) -
							(stageH > 0 ? ((crop.y * k - crop.y * baseK) / stageH) * 100 : 0),
					),
				});
			},
		);
	};

	return (
		<Fragment>
			{/* The whole template box, when the window is only a part of it. */}
			{cropIsFull(crop, template) ? null : (
				<Rect
					x={view.boxX}
					y={view.boxY}
					width={view.boxW}
					height={view.boxH}
					stroke="rgba(255,255,255,0.22)"
					strokeWidth={1}
					dash={[4, 7]}
					listening={false}
				/>
			)}
			<Group x={win.x} y={win.y}>
				{/* The visible window itself: the drag surface for a move. */}
				<Rect
					width={win.width}
					height={win.height}
					fill="rgba(0,0,0,0.001)"
					stroke="rgba(74,168,255,0.9)"
					strokeWidth={1}
					dash={[5, 4]}
					hitStrokeWidth={14}
					onMouseDown={onPlacementDown}
				/>

				{/* Move handle (top-left). */}
				<Group x={0} y={0} onMouseDown={onPlacementDown}>
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
					x={Math.max(0, win.width - HANDLE)}
					y={Math.max(0, win.height - HANDLE)}
					onMouseDown={onSizeDown}
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
		</Fragment>
	);
}

/** `fit` back out of the geometry (boxW = template.width * scale * fit). */
function fitOf(geom: Geometry): number {
	if (geom.template.width > 0 && geom.scale > 0) return geom.k / geom.scale;
	return 1;
}

/** The visible window of a placement on the stage, in stage px. */
function windowOf(geom: Geometry, crop: ItemCrop): SnapBox {
	return {
		x: geom.boxX + crop.x * geom.k,
		y: geom.boxY + crop.y * geom.k,
		width: Math.max(1, crop.width * geom.k),
		height: Math.max(1, crop.height * geom.k),
	};
}

/** The crop to draw for a geometry: the one being dragged, else the saved one. */
function cropFor(geom: Geometry, preview: DragPreview | null): ItemCrop {
	if (preview && preview.itemId === geom.item.id && preview.crop) return preview.crop;
	return cropBox(geom.item, geom.template);
}

// ------------------------------------------------------------------- crop tool

/** Darkens everything outside the crop window. */
const CROP_SHADE = "rgba(4,8,14,0.62)";

/** Where the crop handles sit, as fractions of the window. */
const CROP_ANCHORS: Array<{ id: string; fx: number; fy: number; cursor: string }> = [
	{ id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
	{ id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
	{ id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
	{ id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
	{ id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
	{ id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
	{ id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
	{ id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

const CROP_HANDLE = 12;

/**
 * The crop frame: the visible window of the active placement, with a handle on
 * every corner and edge.
 *
 * Dragging the frame moves it over the animation, dragging a handle resizes it;
 * either way the rest of the canvas is dimmed so it is obvious what is being
 * kept. The frame is measured in the template's own box (the same space the
 * layer drag uses) and written to the placement as template px on release, so
 * the out page can clip at exactly the rectangle that was drawn here.
 */
function CropOverlay({
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
	const snap = useContext(SnapContext);
	const drag = useContext(DragContext);
	const { item, template } = geom;
	const crop = cropFor(geom, drag?.preview ?? null);
	const view = drag ? drag.view(geom) : geom;
	const win = windowOf(view, crop);
	const bounds = { width: geom.boxW, height: geom.boxH };
	/** The window in the box's own px, which is what the drag works in. */
	const local = {
		x: crop.x * geom.k,
		y: crop.y * geom.k,
		width: crop.width * geom.k,
		height: crop.height * geom.k,
	};
	const minSize = Math.max(2, MIN_CROP_PX * geom.k);

	const lines = useMemo(() => boxSnapLines(bounds.width, bounds.height), [bounds.width, bounds.height]);
	const threshold = snap?.threshold ?? 0;

	const toDesign = (box: SnapBox): ItemCrop => ({
		x: box.x / geom.k,
		y: box.y / geom.k,
		width: box.width / geom.k,
		height: box.height / geom.k,
	});

	const showGuides = (x: number[], y: number[]) => {
		// Local box px -> stage px, the same conversion the layer guides use.
		snap?.showLayer(x, y);
	};

	const commit = (next: SnapBox) => {
		const design = roundCrop(toDesign(next));
		if (cropIsFull(design, template)) onItemChange(item.id, { crop: undefined });
		else onItemChange(item.id, { crop: design });
	};

	/** Dragging the window itself: it slides over the animation. */
	const onBodyDown = (event: KonvaEvent<MouseEvent>) => {
		if (!drag) return;
		const start = drag.pointOf(event.evt);
		if (!start) return;
		let next: SnapBox = { ...local };
		drag.begin(
			event,
			(point) => {
				const raw = {
					...local,
					x: clamp(local.x + (point.x - start.x), 0, Math.max(0, bounds.width - local.width)),
					y: clamp(local.y + (point.y - start.y), 0, Math.max(0, bounds.height - local.height)),
				};
				const moved =
					snap?.enabled
						? snapBox(raw, lines.x, lines.y, threshold)
						: { box: raw, guidesX: [], guidesY: [] };
				next = moved.box;
				drag.setPreview({ itemId: item.id, dx: 0, dy: 0, crop: toDesign(next) });
				showGuides(moved.guidesX, moved.guidesY);
			},
			() => {
				drag.setPreview(null);
				snap?.clear();
				commit(next);
			},
		);
	};

	/** Dragging a handle: only the edges under the cursor move. */
	const onAnchorDown =
		(anchor: { fx: number; fy: number }) => (event: KonvaEvent<MouseEvent>) => {
			if (!drag) return;
			const start = drag.pointOf(event.evt);
			if (!start) return;
			let next: SnapBox = { ...local };
			drag.begin(
				event,
				(point) => {
					const right = local.x + local.width;
					const bottom = local.y + local.height;
					let { x, y, width, height } = local;
					const guidesX: number[] = [];
					const guidesY: number[] = [];

					if (anchor.fx === 0) {
						const snapped = snap?.enabled
							? snapCoordinate(x + (point.x - start.x), lines.x, threshold)
							: { value: x + (point.x - start.x), guide: [] };
						x = clamp(snapped.value, 0, right - minSize);
						guidesX.push(...snapped.guide);
						width = right - x;
					} else if (anchor.fx === 1) {
						const snapped = snap?.enabled
							? snapCoordinate(right + (point.x - start.x), lines.x, threshold)
							: { value: right + (point.x - start.x), guide: [] };
						const edge = clamp(snapped.value, x + minSize, bounds.width);
						guidesX.push(...snapped.guide);
						width = edge - x;
					}

					if (anchor.fy === 0) {
						const snapped = snap?.enabled
							? snapCoordinate(y + (point.y - start.y), lines.y, threshold)
							: { value: y + (point.y - start.y), guide: [] };
						y = clamp(snapped.value, 0, bottom - minSize);
						guidesY.push(...snapped.guide);
						height = bottom - y;
					} else if (anchor.fy === 1) {
						const snapped = snap?.enabled
							? snapCoordinate(bottom + (point.y - start.y), lines.y, threshold)
							: { value: bottom + (point.y - start.y), guide: [] };
						const edge = clamp(snapped.value, y + minSize, bounds.height);
						guidesY.push(...snapped.guide);
						height = edge - y;
					}

					next = { x, y, width, height };
					drag.setPreview({ itemId: item.id, dx: 0, dy: 0, crop: toDesign(next) });
					showGuides(guidesX, guidesY);
				},
				() => {
					drag.setPreview(null);
					snap?.clear();
					commit(next);
				},
			);
		};

	return (
		<Fragment>
			{/* Everything outside the window, dimmed. */}
			<Rect x={0} y={0} width={stageW} height={Math.max(0, win.y)} fill={CROP_SHADE} listening={false} />
			<Rect
				x={0}
				y={win.y + win.height}
				width={stageW}
				height={Math.max(0, stageH - win.y - win.height)}
				fill={CROP_SHADE}
				listening={false}
			/>
			<Rect
				x={0}
				y={win.y}
				width={Math.max(0, win.x)}
				height={win.height}
				fill={CROP_SHADE}
				listening={false}
			/>
			<Rect
				x={win.x + win.width}
				y={win.y}
				width={Math.max(0, stageW - win.x - win.width)}
				height={win.height}
				fill={CROP_SHADE}
				listening={false}
			/>

			{/* The template box, so it is clear how much is being cut. */}
			<Rect
				x={view.boxX}
				y={view.boxY}
				width={view.boxW}
				height={view.boxH}
				stroke="rgba(255,255,255,0.28)"
				strokeWidth={1}
				dash={[4, 7]}
				listening={false}
			/>

			<Group x={win.x} y={win.y}>
				<Rect
					width={win.width}
					height={win.height}
					fill="rgba(0,0,0,0.001)"
					onMouseDown={onBodyDown}
				/>
				{/* Thirds, the usual framing help. */}
				<Line
					points={[win.width / 3, 0, win.width / 3, win.height]}
					stroke="rgba(255,255,255,0.18)"
					strokeWidth={1}
					listening={false}
				/>
				<Line
					points={[(win.width / 3) * 2, 0, (win.width / 3) * 2, win.height]}
					stroke="rgba(255,255,255,0.18)"
					strokeWidth={1}
					listening={false}
				/>
				<Line
					points={[0, win.height / 3, win.width, win.height / 3]}
					stroke="rgba(255,255,255,0.18)"
					strokeWidth={1}
					listening={false}
				/>
				<Line
					points={[0, (win.height / 3) * 2, win.width, (win.height / 3) * 2]}
					stroke="rgba(255,255,255,0.18)"
					strokeWidth={1}
					listening={false}
				/>
				<Rect
					width={win.width}
					height={win.height}
					stroke="rgba(255,209,102,0.95)"
					strokeWidth={1}
					listening={false}
				/>
				{CROP_ANCHORS.filter(
					(anchor) =>
						// Mid-edge handles only when the window is big enough to have an
						// edge: on a small crop eight handles would cover all of it and
						// hide the very thing being framed.
						(anchor.fx !== 0.5 || win.width > CROP_HANDLE * 4) &&
						(anchor.fy !== 0.5 || win.height > CROP_HANDLE * 4),
				).map((anchor) => (
					<Rect
						key={anchor.id}
						x={anchor.fx * win.width - CROP_HANDLE / 2}
						y={anchor.fy * win.height - CROP_HANDLE / 2}
						width={CROP_HANDLE}
						height={CROP_HANDLE}
						fill="rgba(255,209,102,0.92)"
						stroke="#0d141c"
						strokeWidth={1}
						cornerRadius={2}
						onMouseDown={onAnchorDown(anchor)}
					/>
				))}
			</Group>

		</Fragment>
	);
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
