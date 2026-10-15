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
 *     «Проиграть» and «В эфир»).
 *
 * Screen layout: one toolbar; placements, layers and the library on the left;
 * the canvas in the middle with the code dock under it for `kind: "code"`; and
 * an inspector on the right, split into tabs by what is being edited — the
 * layer, the placement on this out, or the animation itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { CODE_HIDE_FALLBACK_MS, codeSource } from "../graphics/code-runtime";
import { interpolate } from "../shared/binding";
import { cropBox } from "../shared/crop";
import { BUNDLE_NAME, CODE_EXIT_MAX_MS, CODE_MESSAGES } from "../shared/types";
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
import type { GalleryExample } from "../shared/examples/gallery";
import { EditorCanvas } from "./editor/canvas";
import { useCodeDocument, useTimerFeed } from "./editor/code-preview";
import { TIMER_VAR, type Timer, layersUseTimers, timerPaths } from "../shared/timer";
import { Splitter, useDeskFullscreen, useEditorLayout, type LayoutEdge } from "./editor/layout";
import { MotionTimeline, TransitionFields } from "./editor/motion";
import {
	CheckField,
	ColorField,
	FONT_FAMILIES,
	Field,
	InlineName,
	LAYER_ICON,
	LAYER_TYPE_LABEL,
	NumField,
	Section,
	SelectField,
	TextField,
	clamp,
	formatBytes,
	layerDisplayName,
	resolveAssetUrl,
	round,
	sortByZ,
	useElementSize,
} from "./editor/ui";
import { N_, getLang, t, tr, useLang, type Phrase } from "./i18n";
import {
	absoluteOutUrl,
	addExample,
	addItem,
	clone,
	copyText,
	createTimer,
	defaultPlayback,
	deleteTemplate,
	duplicateTemplate,
	flattenData,
	getDb,
	getTemplate,
	itemCanPlay,
	hideTitle,
	moveItem,
	newId,
	newTemplate,
	removeItem,
	saveTemplate,
	showTitle,
	triggerItem,
	triggerTemplate,
	updateItem,
	updateItemPlayback,
	useActiveTitle,
	useAllTimers,
	useLiveData,
	useOuts,
	useRuntime,
	useSelection,
	useTemplates,
	useTitleData,
} from "./shared";
import {
	Icon,
	IconButton,
	LangSwitch,
	ThemeSwitch,
	Menu,
	PlaybackFields,
	exampleMenuItem,
	type MenuItem,
} from "./ui";

// ------------------------------------------------------------------ helpers

const LAYER_TYPES: LayerType[] = ["text", "shape", "image", "gif", "video"];

/** The "add a layer" choices — the toolbar and the layer list share them. */
function layerMenu(onAdd: (type: LayerType) => void, timer?: MenuItem): MenuItem[] {
	const items: MenuItem[] = LAYER_TYPES.map((type) => ({
		label: t(LAYER_TYPE_LABEL[type]),
		icon: LAYER_ICON[type],
		onSelect: () => onAdd(type),
	}));
	return timer ? [...items, timer] : items;
}

/**
 * A timer on its own: a text layer that shows a timer of the Control panel,
 * its digits all one width so it does not jitter as it counts.
 */
function timerLayer(layer: Layer, key: string): Layer {
	return {
		...layer,
		name: t("Timer"),
		text: "00:00",
		binding: `${TIMER_VAR}.${key}.text`,
		// As wide as its digits: a fixed width would wrap them on a small box.
		width: undefined,
		style: { ...layer.style, fontSize: 72, tabularNums: true },
	};
}

/** "Add layer → Timer": a layer for one of the timers there are, or for a new one. */
function timerMenuItem(timers: Timer[], onAdd: (key: string) => void, onCreate: () => void): MenuItem {
	if (timers.length === 0) {
		return {
			label: t("Timer"),
			hint: t("Makes a timer to start in Control"),
			icon: "timer",
			separated: true,
			onSelect: onCreate,
		};
	}
	return {
		label: t("Timer"),
		icon: "timer",
		separated: true,
		children: [
			...timers.map((timer) => ({
				label: timer.name,
				hint: `{{${TIMER_VAR}.${timer.key}.text}}`,
				icon: "timer" as const,
				onSelect: () => onAdd(timer.key),
			})),
			{ label: t("New timer"), icon: "plus", separated: true, onSelect: onCreate },
		],
	};
}

/** The ways to start an animation: from scratch, or from an example. */
function createMenu(
	onCreate: (kind: TemplateKind) => void,
	onExample: (example: GalleryExample) => void,
): MenuItem[] {
	return [
		{
			label: t("From layers"),
			hint: t("Text, shapes, images and video — built with the mouse"),
			icon: "layers",
			onSelect: () => onCreate("layers"),
		},
		{
			label: t("From code"),
			hint: t("Your own HTML, CSS and JavaScript"),
			icon: "code",
			onSelect: () => onCreate("code"),
		},
		exampleMenuItem(onExample),
	];
}

const TEXT_ALIGNS: Array<{ value: NonNullable<LayerStyle["align"]>; label: Phrase }> = [
	{ value: "left", label: N_("left") },
	{ value: "center", label: N_("center") },
	{ value: "right", label: N_("right") },
];

const VERTICAL_ALIGNS: Array<{ value: NonNullable<LayerStyle["verticalAlign"]>; label: Phrase }> = [
	{ value: "top", label: N_("top") },
	{ value: "middle", label: N_("center") },
	{ value: "bottom", label: N_("bottom") },
];

/** Options kept in a constant, with their labels in the current language. */
function localized<T extends string>(
	options: Array<{ value: T; label: Phrase }>,
): Array<{ value: T; label: string }> {
	return options.map((option) => ({ value: option.value, label: t(option.label) }));
}

const TEXT_TRANSFORMS: Array<{ value: NonNullable<LayerStyle["textTransform"]>; label: Phrase }> = [
	{ value: "none", label: N_("as typed") },
	{ value: "uppercase", label: N_("UPPERCASE") },
	{ value: "lowercase", label: N_("lowercase") },
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
			name: t("Text"),
			text: t("New text"),
			width: 40,
			style: {
				...base.style,
				fontFamily: "Montserrat, 'Segoe UI', Roboto, Arial, sans-serif",
				fontSize: 56,
				fontWeight: 700,
				color: "#f5ecda",
				align: "left",
				lineHeight: 1.15,
				textTransform: "none",
			},
		};
	}
	if (type === "shape") {
		return {
			...base,
			name: t("Shape"),
			shape: "rect",
			width: 30,
			height: 12,
			style: { ...base.style, fill: "#ff5a8c", radius: 8 },
		};
	}
	if (type === "video") {
		// A fresh video layer has a visible 16:9 box and the runtime defaults
		// spelled out, so it is selectable/visible even before a `src` is set.
		return {
			...base,
			name: t("Video"),
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
		name: type === "gif" ? "GIF" : t("Image"),
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

/** Textarea used for layer text. */
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

// ------------------------------------------------------ placements on the out

function OutItemsList({
	out,
	templates,
	draft,
	activeItemId,
	playing,
	onActivate,
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
	onMove: (itemId: string, delta: number) => void;
	onTrigger: (itemId: string) => void;
	onRemove: (itemId: string) => void;
}) {
	const items = orderedItems(out);
	return (
		<section className="ed-group">
			<header className="ed-group__head">
				<h3>{t("On the out")}</h3>
			</header>
			{items.length === 0 ? (
				<p className="ed-hint ed-group__hint">
					{t("Nothing here yet. Place an animation from the library below.")}
				</p>
			) : (
				<div className="ed-list">
					{items.map((item, index) => {
						const template = templates.find((candidate) => candidate.id === item.templateId);
						const live = draft && draft.id === item.templateId ? draft : template;
						const canPlay = itemCanPlay(item, live);
						const name = live?.name ?? "—";
						const onAir = playing.includes(item.id);
						return (
							<div
								key={item.id}
								className={`ed-list-item${item.id === activeItemId ? " is-selected" : ""}${
									item.enabled ? "" : " is-hidden"
								}`}
								onClick={() => onActivate(item.id)}
							>
								<span
									className={`tally${onAir ? " is-live" : ""}`}
									title={onAir ? t("On air") : undefined}
								/>
								<span
									className="ed-list-item__name"
									title={item.enabled ? name : t("{name} — API start is off", { name })}
								>
									{name}
								</span>
								<span
									className="ed-list-item__actions"
									onClick={(event) => event.stopPropagation()}
								>
									<IconButton
										className="small"
										icon="up"
										size={14}
										label={t("Move up")}
										disabled={index === 0}
										onClick={() => onMove(item.id, -1)}
									/>
									<IconButton
										className="small"
										icon="down"
										size={14}
										label={t("Move down")}
										disabled={index >= items.length - 1}
										onClick={() => onMove(item.id, 1)}
									/>
									<IconButton
										className="small"
										icon="play"
										size={14}
										data-can-play={canPlay ? "true" : "false"}
										label={
											canPlay
												? t("Play once")
												: t("An animation that stays up is switched on in Control")
										}
										disabled={!canPlay}
										onClick={() => onTrigger(item.id)}
									/>
									<IconButton
										className="small ed-danger"
										icon="x"
										size={14}
										label={t("Remove from out")}
										onClick={() => onRemove(item.id)}
									/>
								</span>
							</div>
						);
					})}
				</div>
			)}
		</section>
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
	onExample,
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
	onExample: (example: GalleryExample) => void;
	onDuplicate: (id: string) => void;
	onDelete: (id: string) => void;
	onRename: (id: string, name: string) => void;
}) {
	return (
		<section className="ed-group">
			<header className="ed-group__head">
				<h3>{t("Library")}</h3>
				<Menu
					className="small"
					icon="plus"
					label={t("New animation")}
					items={createMenu(onCreate, onExample)}
				/>
			</header>
			{templates.length === 0 ? (
				<p className="ed-hint ed-group__hint">
					{t("No animations yet. The “+” button creates one or adds a ready-made example.")}
				</p>
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
								<span
									className="ed-kind"
									title={template.kind === "code" ? t("Code") : t("Layers")}
								>
									<Icon name={template.kind === "code" ? "code" : "layers"} size={14} />
								</span>
								<span className="ed-list-item__name">
									<InlineName
										value={name}
										placeholder={t("Untitled")}
										onChange={(next) => onRename(template.id, next)}
									/>
								</span>
								<span
									className="ed-list-item__actions"
									onClick={(event) => event.stopPropagation()}
								>
									{!placed ? (
										<IconButton
											className="small"
											icon="plus"
											size={14}
											label={t("Place on this out")}
											onClick={() => onPlace(template.id)}
										/>
									) : null}
									<IconButton
										className="small"
										icon="copy"
										size={14}
										label={t("Duplicate")}
										onClick={() => onDuplicate(template.id)}
									/>
									<IconButton
										className="small ed-danger"
										icon="trash"
										size={14}
										label={t("Delete")}
										onClick={() => onDelete(template.id)}
									/>
								</span>
							</div>
						);
					})}
				</div>
			)}
		</section>
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
	timerItem,
}: {
	layers: Layer[];
	selectedLayerId: string | null;
	onSelect: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onPatch: (id: string, patch: Partial<Layer>) => void;
	onMove: (id: string, delta: number) => void;
	onDelete: (id: string) => void;
	onAdd: (type: LayerType) => void;
	timerItem?: MenuItem;
}) {
	const ordered = useMemo(() => sortByZ(layers).reverse(), [layers]);
	return (
		<section className="ed-group">
			<header className="ed-group__head">
				<h3>{t("Layers")}</h3>
				<Menu className="small" icon="plus" label={t("Add layer")} items={layerMenu(onAdd, timerItem)} />
			</header>
			{ordered.length === 0 ? (
				<p className="ed-hint ed-group__hint">
					{t("No layers yet. Add text, a shape or an image with the “+” button.")}
				</p>
			) : (
				<div className="ed-list">
					{ordered.map((layer, index) => (
						<div
							key={layer.id}
							className={`ed-list-item${layer.id === selectedLayerId ? " is-selected" : ""}${
								layer.hidden ? " is-hidden" : ""
							}`}
							onClick={() => onSelect(layer.id)}
						>
							<span className="ed-kind" title={t(LAYER_TYPE_LABEL[layer.type])}>
								<Icon name={LAYER_ICON[layer.type]} size={14} />
							</span>
							<span className="ed-list-item__name">
								<InlineName
									value={layer.name ?? ""}
									placeholder={layerDisplayName(layer)}
									onChange={(name) => onRename(layer.id, name)}
								/>
							</span>
							{/* A state that is on stays visible and is its own "off" button. */}
							{layer.hidden || layer.locked ? (
								<span
									className="ed-list-item__state"
									onClick={(event) => event.stopPropagation()}
								>
									{layer.hidden ? (
										<IconButton
											className="small"
											icon="eyeOff"
											size={14}
											label={t("Hidden — show it")}
											onClick={() => onPatch(layer.id, { hidden: false })}
										/>
									) : null}
									{layer.locked ? (
										<IconButton
											className="small"
											icon="lock"
											size={14}
											label={t("Locked — unlock it")}
											onClick={() => onPatch(layer.id, { locked: false })}
										/>
									) : null}
								</span>
							) : null}
							<span
								className="ed-list-item__actions"
								onClick={(event) => event.stopPropagation()}
							>
								<IconButton
									className="small"
									icon="up"
									size={14}
									label={t("Move up")}
									disabled={index === 0}
									onClick={() => onMove(layer.id, 1)}
								/>
								<IconButton
									className="small"
									icon="down"
									size={14}
									label={t("Move down")}
									disabled={index >= ordered.length - 1}
									onClick={() => onMove(layer.id, -1)}
								/>
								{!layer.hidden ? (
									<IconButton
										className="small"
										icon="eye"
										size={14}
										label={t("Hide")}
										onClick={() => onPatch(layer.id, { hidden: true })}
									/>
								) : null}
								{!layer.locked ? (
									<IconButton
										className="small"
										icon="unlock"
										size={14}
										label={t("Lock")}
										onClick={() => onPatch(layer.id, { locked: true })}
									/>
								) : null}
								<IconButton
									className="small ed-danger"
									icon="x"
									size={14}
									label={t("Delete layer")}
									onClick={() => onDelete(layer.id)}
								/>
							</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

// ---------------------------------------------------------------- media drop

const MEDIA_BASE = `/bundles/${BUNDLE_NAME}/media`;

/** A `<video>` element can only play WebM, so only that counts for this panel. */
function isVideoFile(name: string): boolean {
	return /\.webm$/i.test(name);
}

function mediaExt(name: string): string {
	const match = /\.([a-z0-9]+)$/i.exec(name);
	return match ? match[1]!.toLowerCase() : t("file");
}
const MEDIA_ACCEPT =
	"video/*,image/*,.mov,.mp4,.mkv,.webm,.webp,.gif,.m4v,.avi";
const MEDIA_LIST_LIMIT = 8;

interface MediaFile {
	name: string;
	src: string;
	bytes: number;
	mtime: number;
}

interface MediaJob {
	id: string;
	state: "converting" | "done" | "error";
	progress: number;
	message: string;
	originalName: string;
	src?: string;
	format?: string;
	bytes?: number;
	inputBytes?: number;
	error?: string;
}

type MediaStage = "idle" | "upload" | "convert" | "done" | "error";

/** File name from a `/assets/notGT/media/<name>` URL (percent-decoded). */
function mediaNameFromSrc(src: string): string {
	const last = src.split("/").pop() ?? "";
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

/**
 * Drag-and-drop upload for the `video` layer.
 *
 * The panel posts the raw bytes with XMLHttpRequest (so `upload.onprogress`
 * drives a real upload bar), then polls the server job for the ffmpeg
 * conversion stage. A finished file is only written into the editor's *local
 * draft* (`onPick` → `onPatch`), so `Сохранить` still decides when it reaches
 * the Replicant.
 */
function MediaDropZone({
	currentSrc,
	onPick,
	onUploaded,
}: {
	currentSrc: string;
	onPick: (src: string) => void;
	/** Fired only when a freshly uploaded file lands, not when picking an existing one. */
	onUploaded?: (src: string) => void;
}) {
	const [dragActive, setDragActive] = useState(false);
	const [stage, setStage] = useState<MediaStage>("idle");
	const [progress, setProgress] = useState(0);
	const [message, setMessage] = useState("");
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [result, setResult] = useState<
		{ name: string; bytes: number; format: string; src: string } | null
	>(null);
	const [files, setFiles] = useState<MediaFile[]>([]);
	const [listError, setListError] = useState("");

	const inputRef = useRef<HTMLInputElement | null>(null);
	const dragDepth = useRef(0);
	const xhrRef = useRef<XMLHttpRequest | null>(null);
	const pollRef = useRef<number | undefined>(undefined);
	const aliveRef = useRef(true);

	const busy = stage === "upload" || stage === "convert";
	const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			if (pollRef.current !== undefined) window.clearTimeout(pollRef.current);
			xhrRef.current?.abort();
		};
	}, []);

	const refreshList = useCallback(async () => {
		try {
			const res = await fetch(`${MEDIA_BASE}/list`, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { files?: MediaFile[] };
			if (!aliveRef.current) return;
			setFiles(Array.isArray(json.files) ? json.files : []);
			setListError("");
		} catch (err) {
			if (!aliveRef.current) return;
			setListError(
				t("Could not load the list: {error}", {
					error: String((err as Error)?.message ?? err),
				}),
			);
		}
	}, []);

	useEffect(() => {
		void refreshList();
	}, [refreshList]);

	const fail = useCallback((text: string) => {
		if (!aliveRef.current) return;
		if (pollRef.current !== undefined) {
			window.clearTimeout(pollRef.current);
			pollRef.current = undefined;
		}
		setStage("error");
		setProgress(0);
		setMessage("");
		setError(text || t("Could not upload the file"));
	}, []);

	const pollJob = useCallback(
		(jobId: string) => {
			const tick = async () => {
				if (!aliveRef.current) return;
				try {
					const res = await fetch(`${MEDIA_BASE}/jobs/${encodeURIComponent(jobId)}`);
					const json = (await res.json().catch(() => ({}))) as {
						job?: MediaJob;
						error?: string;
						message?: string;
					};
					if (!aliveRef.current) return;
					if (!res.ok || !json.job) {
						fail(json.message ?? json.error ?? t("The server returned HTTP {status}", { status: res.status }));
						return;
					}
					const job = json.job;
					if (job.state === "error") {
						fail(job.error ?? job.message ?? t("Conversion failed"));
						return;
					}
					if (job.state === "done") {
						const src = job.src ?? "";
						setStage("done");
						setProgress(1);
						setMessage(job.message || t("Done"));
						setError("");
						setResult({
							name: src ? mediaNameFromSrc(src) : job.originalName,
							bytes: job.bytes ?? 0,
							format: job.format ?? "",
							src,
						});
						if (src) {
							onPick(src);
							onUploaded?.(src);
						}
						void refreshList();
						return;
					}
					// Still converting: the server streams real ffmpeg progress.
					setStage("convert");
					setProgress(
						Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : 0,
					);
					setMessage(job.message || t("Converting"));
					pollRef.current = window.setTimeout(() => {
						void tick();
					}, 500);
				} catch (err) {
					fail(
						t("Could not get the status: {error}", {
							error: String((err as Error)?.message ?? err),
						}),
					);
				}
			};
			void tick();
		},
		[fail, onPick, onUploaded, refreshList],
	);

	const startUpload = useCallback(
		(file: File) => {
			if (xhrRef.current) return;
			if (pollRef.current !== undefined) {
				window.clearTimeout(pollRef.current);
				pollRef.current = undefined;
			}
			setStage("upload");
			setProgress(0);
			setMessage("0%");
			setError("");
			setResult(null);

			const xhr = new XMLHttpRequest();
			xhrRef.current = xhr;
			// `kind=video`: this drop zone lives in the video inspector, so the
			// server must produce a WebM (a <video> cannot play WebP/GIF).
			xhr.open(
				"POST",
				`${MEDIA_BASE}/upload?kind=video&name=${encodeURIComponent(file.name)}`,
			);
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.upload.onprogress = (event) => {
				if (!aliveRef.current || !event.lengthComputable || event.total <= 0) return;
				const ratio = event.loaded / event.total;
				setProgress(ratio);
				setMessage(`${Math.round(ratio * 100)}%`);
			};
			xhr.onerror = () => {
				xhrRef.current = null;
				fail(t("Network error while uploading the file"));
			};
			xhr.onabort = () => {
				xhrRef.current = null;
				if (!aliveRef.current) return;
				setStage("idle");
				setProgress(0);
				setMessage("");
			};
			xhr.onload = () => {
				xhrRef.current = null;
				let payload: { ok?: boolean; jobId?: string; error?: string } = {};
				try {
					payload = JSON.parse(xhr.responseText) as typeof payload;
				} catch {
					// Non-JSON body — the status check below reports it.
				}
				if (xhr.status >= 200 && xhr.status < 300 && payload.ok && payload.jobId) {
					if (!aliveRef.current) return;
					setStage("convert");
					setProgress(0);
					setMessage(t("Waiting for the server…"));
					pollJob(payload.jobId);
					return;
				}
				fail(payload.error ?? t("The server rejected the upload (HTTP {status})", { status: xhr.status }));
			};
			xhr.send(file);
		},
		[fail, pollJob],
	);

	const handleFiles = useCallback(
		(list: FileList | File[] | null) => {
			const picked = list ? Array.from(list) : [];
			if (picked.length === 0) return;
			if (picked.length > 1) {
				setNotice(
					t("{count} files chosen — taking the first: {name}", {
						count: picked.length,
						name: picked[0]!.name,
					}),
				);
			} else {
				setNotice("");
			}
			startUpload(picked[0]!);
		},
		[startUpload],
	);

	const removeFile = useCallback(
		async (file: MediaFile) => {
			if (!window.confirm(t("Delete “{name}” from storage?", { name: file.name }))) return;
			try {
				const res = await fetch(`${MEDIA_BASE}/file/${encodeURIComponent(file.name)}`, {
					method: "DELETE",
				});
				if (!res.ok) {
					const json = (await res.json().catch(() => ({}))) as { message?: string };
					if (aliveRef.current) {
						setListError(json.message ?? t("Could not delete (HTTP {status})", { status: res.status }));
					}
					return;
				}
				setListError("");
				await refreshList();
			} catch (err) {
				if (aliveRef.current) setListError(String((err as Error)?.message ?? err));
			}
		},
		[refreshList],
	);

	const openPicker = () => {
		if (busy) return;
		inputRef.current?.click();
	};

	const stageLabel = stage === "upload" ? t("Uploading") : stage === "convert" ? t("Converting") : "";

	return (
		<>
			<div
				className={`ed-drop${dragActive ? " is-drag" : ""}${busy ? " is-busy" : ""}`}
				role="button"
				tabIndex={0}
				aria-disabled={busy}
				title={busy ? t("The file is being processed…") : t("Drop a file or click to choose one")}
				onClick={openPicker}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						openPicker();
					}
				}}
				onDragEnter={(event) => {
					event.preventDefault();
					dragDepth.current += 1;
					if (!busy) setDragActive(true);
				}}
				onDragOver={(event) => {
					event.preventDefault();
					if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
					if (!busy) setDragActive(true);
				}}
				onDragLeave={(event) => {
					event.preventDefault();
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) setDragActive(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					dragDepth.current = 0;
					setDragActive(false);
					if (busy) return;
					handleFiles(event.dataTransfer?.files ?? null);
				}}
			>
				<input
					ref={inputRef}
					type="file"
					className="ed-drop__input"
					accept={MEDIA_ACCEPT}
					disabled={busy}
					onChange={(event) => {
						const picked = event.target.files ? Array.from(event.target.files) : [];
						event.target.value = "";
						handleFiles(picked);
					}}
				/>
				<div className="ed-drop__title">
					{busy ? t("Processing…") : t("Drop a video or an image here")}
				</div>
				<div className="ed-drop__hint">
					{busy
						? t("Keep this panel open until the file is ready")
						: t("…or click to choose a file")}
				</div>
			</div>

			{busy ? (
				<div className="ed-drop__prog">
					<div className="ed-drop__prog-head">
						<span className="ed-drop__stage">{stageLabel}</span>
						<span className="ed-drop__pct">{percent}%</span>
					</div>
					<div
						className="ed-progress"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						aria-label={stageLabel}
					>
						<div className="ed-progress__fill" style={{ width: `${percent}%` }} />
					</div>
					{message && message !== `${percent}%` ? (
						<div className="ed-drop__msg">{message}</div>
					) : null}
				</div>
			) : null}

			{stage === "done" && result ? (
				<div className="ed-drop__result">
					<div className="ed-drop__ok">
						✓ {result.name}
						{result.bytes > 0 ? ` · ${formatBytes(result.bytes)}` : ""}
						{result.format ? ` · ${result.format}` : ""}
					</div>
					<div className="ed-hint">
						{t("The file is set in the field below. “Save” applies it.")}
					</div>
				</div>
			) : null}

			{stage === "error" && error ? (
				<div className="ed-drop__error" role="alert">
					{error}
				</div>
			) : null}

			{notice && !busy ? <div className="ed-hint">{notice}</div> : null}

			<div className="ed-media">
				<div className="ed-media__head">
					<span className="ed-media__title">{t("Uploaded files")}</span>
					<IconButton
						className="small"
						icon="restart"
						size={14}
						label={t("Refresh the list")}
						onClick={() => void refreshList()}
					/>
				</div>
				{listError ? (
					<div className="ed-drop__error" role="alert">
						{listError}
					</div>
				) : null}
				{files.length === 0 ? (
					<div className="ed-hint">{t("Nothing uploaded yet.")}</div>
				) : (
					<div className="ed-media__list">
						{files.slice(0, MEDIA_LIST_LIMIT).map((file) => (
							<div
								key={file.name}
								className={`ed-media__item${file.src === currentSrc ? " is-selected" : ""}`}
								title={file.name}
							>
								<button
									type="button"
									className="ed-media__pick"
									title={
										isVideoFile(file.name)
											? t("Use: {src}", { src: file.src })
											: t("An image — a video layer cannot play it")
									}
									onClick={() => {
										if (!isVideoFile(file.name)) {
											setNotice(
												t(
													"“{name}” is an image ({ext}). A video layer only plays .webm, so the field is left as it is. Drop the source here and the server converts it to video; put an image into an “Image” or “GIF” layer.",
													{ name: file.name, ext: mediaExt(file.name) },
												),
											);
											return;
										}
										setNotice("");
										onPick(file.src);
									}}
								>
									<span className="ed-media__name">{file.name}</span>
									{!isVideoFile(file.name) ? (
										<span className="ed-media__tag">{t("image")}</span>
									) : null}
									<span className="ed-media__size">{formatBytes(file.bytes)}</span>
								</button>
								<IconButton
									className="small ed-danger"
									icon="trash"
									size={14}
									label={t("Delete file")}
									onClick={() => void removeFile(file)}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		</>
	);
}

// ------------------------------------------------------------ layer inspector

function LayerInspector({
	layer,
	data,
	selection,
	dataPaths,
	previewPlaying,
	onPatch,
	onStyle,
	onTogglePreview,
	onRestartPreview,
	onUploaded,
}: {
	layer: Layer;
	data: TitleData;
	selection: VariableSelection;
	dataPaths: string[];
	previewPlaying: boolean;
	onPatch: (patch: Partial<Layer>) => void;
	onStyle: (patch: Partial<LayerStyle>) => void;
	onTogglePreview: () => void;
	onRestartPreview: () => void;
	onUploaded: (src: string) => void;
}) {
	const style = layer.style ?? {};
	const srcPreview = layer.src
		? resolveAssetUrl(interpolate(layer.src, data, selection))
		: "";

	return (
		<div className="ed-panel-body">
			<Section title={t("Position and size")}>
				<TextField
					label={t("Name")}
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
						label={t("Width")}
						suffix="%"
						step={0.5}
						value={layer.width}
						onChange={(value) => onPatch({ width: Math.max(0.1, round(value)) })}
					/>
					<NumField
						label={t("Height")}
						suffix="%"
						step={0.5}
						value={layer.height}
						onChange={(value) => onPatch({ height: Math.max(0.1, round(value)) })}
					/>
					<NumField
						label={t("Rotation")}
						suffix="°"
						step={1}
						value={style.rotation ?? 0}
						onChange={(value) => onStyle({ rotation: round(value, 1) })}
					/>
					<NumField
						label={t("Opacity")}
						step={0.05}
						min={0}
						max={1}
						value={style.opacity ?? 1}
						onChange={(value) => onStyle({ opacity: clamp(value, 0, 1) })}
					/>
					</div>
				<button
					type="button"
					className="small ed-start"
					title={t("Drop the set width and height: the layer takes the size of its content")}
					onClick={() => onPatch({ width: undefined, height: undefined })}
				>
					{t("Size to content")}
				</button>
			</Section>

			{layer.type === "text" ? (
				<>
					<Section title={t("Text")}>
						<CodeArea
							label={t("Text")}
							value={layer.text}
							rows={3}
							placeholder={t("{{speaker.name ?? Name}}")}
							onChange={(value) => onPatch({ text: value })}
						/>
						<Field label={t("Variable")}>
							<input
								type="text"
								className="ed-mono"
								list="ed-data-paths"
								value={layer.binding ?? ""}
								placeholder="speaker.name"
								onChange={(event) => onPatch({ binding: event.target.value })}
							/>
							<datalist id="ed-data-paths">
								{dataPaths.map((path) => (
									<option key={path} value={path} />
								))}
							</datalist>
						</Field>
						<div className="ed-hint">
							{tr(
								"With a variable set, the layer shows its value. Otherwise it shows the text above, where {token} is replaced by a value.",
								{ token: <code>{t("{{path}}")}</code> },
							)}
						</div>
					</Section>

					<Section title={t("Typography")} defaultOpen={false}>
						<Field label={t("Font")}>
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
								label={t("Size")}
								suffix="px"
								step={1}
								min={1}
								value={style.fontSize ?? 48}
								onChange={(value) => onStyle({ fontSize: Math.max(1, Math.round(value)) })}
							/>
							<SelectField
								label={t("Weight")}
								value={String(style.fontWeight ?? 400)}
								options={FONT_WEIGHTS}
								onChange={(value) => onStyle({ fontWeight: Number(value) })}
							/>
							<NumField
								label={t("Line height")}
								step={0.05}
								min={0.5}
								value={style.lineHeight ?? 1.2}
								onChange={(value) => onStyle({ lineHeight: clamp(value, 0.5, 5) })}
							/>
							<NumField
								label={t("Letter spacing")}
								suffix="px"
								step={0.1}
								value={style.letterSpacing ?? 0}
								onChange={(value) => onStyle({ letterSpacing: value })}
							/>
							<NumField
								label={t("Padding")}
								suffix="px"
								step={1}
								value={style.padding ?? 0}
								onChange={(value) => onStyle({ padding: value })}
							/>
							<SelectField
								label={t("Italic")}
								value={style.fontStyle ?? "normal"}
								options={[
									{ value: "normal", label: t("normal") },
									{ value: "italic", label: t("italic") },
								]}
								onChange={(value) => onStyle({ fontStyle: value })}
							/>
							<SelectField
								label={t("Align")}
								value={style.align ?? "left"}
								options={localized(TEXT_ALIGNS)}
								onChange={(value) => onStyle({ align: value })}
							/>
							<SelectField
								label={t("Vertical align")}
								value={style.verticalAlign ?? "top"}
								options={localized(VERTICAL_ALIGNS)}
								onChange={(value) => onStyle({ verticalAlign: value })}
							/>
							<SelectField
								label={t("Case")}
								value={style.textTransform ?? "none"}
								options={localized(TEXT_TRANSFORMS)}
								onChange={(value) => onStyle({ textTransform: value })}
							/>
							<ColorField
								label={t("Color")}
								value={style.color}
								onChange={(value) => onStyle({ color: value })}
							/>
						</div>
					</Section>

					<Section title={t("Stroke, shadow, plate")} defaultOpen={false}>
						<div className="ed-grid2">
							<ColorField
								label={t("Stroke color")}
								value={style.textStrokeColor}
								onChange={(value) => onStyle({ textStrokeColor: value })}
							/>
							<NumField
								label={t("Stroke width")}
								suffix="px"
								step={1}
								value={style.textStrokeWidth ?? 0}
								onChange={(value) => onStyle({ textStrokeWidth: value })}
							/>
							<ColorField
								label={t("Shadow color")}
								value={style.shadowColor}
								onChange={(value) => onStyle({ shadowColor: value })}
							/>
							<NumField
								label={t("Shadow blur")}
								suffix="px"
								step={1}
								value={style.shadowBlur ?? 0}
								onChange={(value) => onStyle({ shadowBlur: value })}
							/>
							<NumField
								label={t("Shadow X")}
								suffix="px"
								step={1}
								value={style.shadowOffsetX ?? 0}
								onChange={(value) => onStyle({ shadowOffsetX: value })}
							/>
							<NumField
								label={t("Shadow Y")}
								suffix="px"
								step={1}
								value={style.shadowOffsetY ?? 0}
								onChange={(value) => onStyle({ shadowOffsetY: value })}
							/>
							<ColorField
								label={t("Plate fill")}
								value={style.fill}
								onChange={(value) => onStyle({ fill: value })}
							/>
							<NumField
								label={t("Corner radius")}
								suffix="px"
								step={1}
								value={style.radius ?? 0}
								onChange={(value) => onStyle({ radius: Math.max(0, value) })}
							/>
						</div>
						<div className="ed-hint">
							{t("The plate is drawn only when the layer has a width and a height.")}
						</div>
					</Section>
				</>
			) : null}

			{layer.type === "shape" ? (
				<Section title={t("Shape")}>
					<SelectField
						label={t("Shape type")}
						value={layer.shape ?? "rect"}
						options={[
							{ value: "rect", label: t("rectangle") },
							{ value: "ellipse", label: t("ellipse") },
						]}
						onChange={(value) => onPatch({ shape: value })}
					/>
					<div className="ed-grid2">
						<ColorField
							label={t("Fill")}
							value={style.fill}
							onChange={(value) => onStyle({ fill: value })}
						/>
						<ColorField
							label={t("Stroke")}
							value={style.stroke}
							onChange={(value) => onStyle({ stroke: value })}
						/>
						<NumField
							label={t("Stroke width")}
							suffix="px"
							step={1}
							value={style.strokeWidth ?? 0}
							onChange={(value) => onStyle({ strokeWidth: Math.max(0, value) })}
						/>
						<NumField
							label={t("Corner radius")}
							suffix="px"
							step={1}
							value={style.radius ?? 0}
							onChange={(value) => onStyle({ radius: Math.max(0, value) })}
						/>
						<ColorField
							label={t("Shadow color")}
							value={style.shadowColor}
							onChange={(value) => onStyle({ shadowColor: value })}
						/>
						<NumField
							label={t("Shadow blur")}
							suffix="px"
							step={1}
							value={style.shadowBlur ?? 0}
							onChange={(value) => onStyle({ shadowBlur: value })}
						/>
						<NumField
							label={t("Shadow X")}
							suffix="px"
							step={1}
							value={style.shadowOffsetX ?? 0}
							onChange={(value) => onStyle({ shadowOffsetX: value })}
						/>
						<NumField
							label={t("Shadow Y")}
							suffix="px"
							step={1}
							value={style.shadowOffsetY ?? 0}
							onChange={(value) => onStyle({ shadowOffsetY: value })}
						/>
					</div>
				</Section>
			) : null}

			{layer.type === "video" ? (
				<Section title={t("Video")}>
					<MediaDropZone
						currentSrc={layer.src ?? ""}
						onPick={(src) => onPatch({ src })}
						onUploaded={onUploaded}
					/>
					<TextField
						label={t("URL or path")}
						mono
						value={layer.src}
						placeholder={t("media/clip.mp4 or https://…")}
						onChange={(value) => onPatch({ src: value })}
					/>
					<div className="ed-hint">
						{tr("A full URL, or a path relative to {dir}. {token} works here.", {
							dir: <code>/bundles/notGT/graphics/</code>,
							token: <code>{t("{{path}}")}</code>,
						})}
					</div>
					<div className="ed-preview">
						<button
							type="button"
							className={`small${previewPlaying ? " is-on" : ""}`}
							title={previewPlaying ? t("Stop the preview") : t("Watch the clip on the canvas")}
							aria-pressed={previewPlaying}
							onClick={onTogglePreview}
						>
							<Icon name={previewPlaying ? "pause" : "play"} size={14} />
							{previewPlaying ? t("Pause") : t("Watch")}
						</button>
						<button
							type="button"
							className="ghost small"
							title={t("Rewind the clip")}
							onClick={onRestartPreview}
						>
							<Icon name="restart" size={14} />
							{t("Rewind")}
						</button>
					</div>
					<div className="ed-hint">
						{t("The preview plays only this layer and is always muted. On the out the clip follows the settings below.")}
					</div>
					<div className="ed-grid2">
						<CheckField
							label={t("Autoplay")}
							checked={style.videoAutoplay ?? true}
							onChange={(value) => onStyle({ videoAutoplay: value })}
						/>
						<CheckField
							label={t("Loop")}
							checked={style.videoLoop ?? true}
							onChange={(value) => onStyle({ videoLoop: value })}
						/>
						<CheckField
							label={t("Muted")}
							checked={style.videoMuted ?? true}
							onChange={(value) => onStyle({ videoMuted: value })}
						/>
						<NumField
							label={t("Speed")}
							step={0.05}
							min={0.05}
							max={4}
							value={style.videoRate ?? 1}
							onChange={(value) => onStyle({ videoRate: clamp(value, 0.05, 4) })}
						/>
						<NumField
							label={t("Corner radius")}
							suffix="px"
							step={1}
							value={style.radius ?? 0}
							onChange={(value) => onStyle({ radius: Math.max(0, value) })}
						/>
					</div>
					
				</Section>
			) : null}

			{layer.type === "image" || layer.type === "gif" ? (
				<Section title={layer.type === "gif" ? "GIF" : t("Image")}>
					<TextField
						label={t("URL or path")}
						mono
						value={layer.src}
						placeholder={t("media/logo.png or https://…")}
						onChange={(value) => onPatch({ src: value })}
					/>
					<div className="ed-hint">
						{tr("A full URL, or a path relative to {dir}. {token} works here.", {
							dir: <code>/bundles/notGT/graphics/</code>,
							token: <code>{t("{{path}}")}</code>,
						})}
					</div>
					{srcPreview ? (
						<img className="ed-image-preview" src={srcPreview} alt="" />
					) : (
						<div className="ed-image-preview ed-image-preview--empty" data-theme="dark">{t("No image set")}</div>
					)}
					<div className="ed-grid2">
						<NumField
							label={t("Corner radius")}
							suffix="px"
							step={1}
							value={style.radius ?? 0}
							onChange={(value) => onStyle({ radius: Math.max(0, value) })}
						/>
					</div>
				</Section>
			) : null}

			<Section title={t("Entrance and exit")} defaultOpen={false}>
				<TransitionFields
					phase="in"
					value={layer.inTransition}
					optional
					onChange={(next) => onPatch({ inTransition: next })}
				/>
				<TransitionFields
					phase="out"
					value={layer.outTransition}
					optional
					onChange={(next) => onPatch({ outTransition: next })}
				/>
				<div className="ed-hint">
					{t(
						"A layer's own entrance and exit play together with the animation's. The “Animation” tab shows all of them on one timeline.",
					)}
				</div>
			</Section>
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
	onCrop,
}: {
	out: Out;
	item: OutItem;
	template: TitleTemplate;
	onPatch: (patch: Partial<OutItem>) => void;
	onPlayback: (patch: Partial<PlaybackConfig>) => void;
	onRemove: () => void;
	onFitOut: () => void;
	/** Turns the crop tool on. */
	onCrop: () => void;
}) {
	const playback = item.playback ?? defaultPlayback();
	const crop = item.crop ? cropBox(item, template) : null;

	return (
		<div className="ed-panel-body">
			<Section title={t("Position")}>
				<div className="ed-grid3">
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
						label={t("Scale")}
						step={0.05}
						min={0.02}
						max={20}
						value={item.scale}
						onChange={(value) => onPatch({ scale: round(clamp(value, 0.02, 20), 4) })}
					/>
				</div>
				<button
					type="button"
					className="small ed-start"
					title={t("Stretch {box} to the full width of the out, {out}", {
						box: `${template.width}×${template.height}`,
						out: `${out.width}×${out.height}`,
					})}
					onClick={onFitOut}
				>
					<Icon name="fit" size={14} />
					{t("Fit out width")}
				</button>
			</Section>

			<Section title={t("Crop")}>
				{crop ? (
					<div className="ed-crop-row">
						<span data-crop-info>
							{t("{size} px from ({x}, {y})", {
								size: `${Math.round(crop.width)}×${Math.round(crop.height)}`,
								x: Math.round(crop.x),
								y: Math.round(crop.y),
							})}
						</span>
						<button
							type="button"
							className="ghost small"
							onClick={() => onPatch({ crop: undefined })}
							data-crop-clear
						>
							{t("Clear")}
						</button>
					</div>
				) : (
					<div className="ed-crop-row">
						<span className="ed-hint" data-crop-none>
							{t("The whole animation is visible")}
						</span>
						<button type="button" className="small" onClick={onCrop}>
							<Icon name="crop" size={14} />
							{t("Set crop")}
						</button>
					</div>
				)}
			</Section>

			<Section title={t("Playback")}>
				<PlaybackFields
					playback={playback}
					template={template}
					scope="placement"
					onChange={onPlayback}
				/>
				<CheckField
					label={t("Starts from the API and Companion")}
					checked={item.enabled}
					onChange={(value) => onPatch({ enabled: value })}
				/>
			</Section>

			<button type="button" className="danger ed-start" onClick={onRemove}>
				<Icon name="trash" size={14} />
				{t("Remove from out")}
			</button>
		</div>
	);
}

// --------------------------------------------------------- template settings

/** Which phases a code animation animates itself, as its own runtime reports. */
interface CodeHooks {
	show: boolean;
	hide: boolean;
	hideMs: number;
}

/**
 * The exit length of a code animation has one source: what the code declares
 * with `onHide(fn, ms)`. `code.exitMs` — the number the scheduler uses to start
 * the exit early — is derived from it instead of being typed in a second time.
 */
function declaredExitMs(hooks: CodeHooks, stored: number): number {
	if (!hooks.hide) return 0;
	if (hooks.hideMs > 0) return Math.min(CODE_EXIT_MAX_MS, Math.round(hooks.hideMs));
	// `onHide(fn)` without a number: the out page waits the stored budget, or
	// its own fallback — keep the scheduler on the same figure.
	return stored > 0 ? stored : CODE_HIDE_FALLBACK_MS;
}

function TemplateSettings({
	template,
	hooks,
	focusLayerId,
	onPatch,
	onLayer,
}: {
	template: TitleTemplate;
	/** Reported by the live preview; `null` until it has loaded. */
	hooks: CodeHooks | null;
	/** The layer selected on the canvas, if any: the timeline opens on it. */
	focusLayerId: string | null;
	onPatch: (patch: Partial<TitleTemplate>) => void;
	onLayer: (layerId: string, patch: Partial<Layer>) => void;
}) {
	const playback = template.playback ?? defaultPlayback();
	// A code animation animates its own entrance and exit (`onShow` / `onHide`),
	// so it has no transition settings to show: the system never animates its
	// wrapper, and the fields would be a lie.
	const isCode = template.kind === "code";
	const exitMs = template.code?.exitMs ?? 0;

	return (
		<div className="ed-panel-body">
			<Section title={t("Animation")}>
				<TextField
					label={t("Name")}
					value={template.name}
					onChange={(value) => onPatch({ name: value })}
				/>
				<div className="ed-grid2">
					<NumField
						label={t("Width")}
						suffix="px"
						step={10}
						min={16}
						value={template.width}
						onChange={(value) => onPatch({ width: Math.max(16, Math.round(value)) })}
					/>
					<NumField
						label={t("Height")}
						suffix="px"
						step={10}
						min={16}
						value={template.height}
						onChange={(value) => onPatch({ height: Math.max(16, Math.round(value)) })}
					/>
				</div>
				<dl className="ed-facts">
					<dt>{t("Built")}</dt>
					<dd>{isCode ? t("from code: HTML, CSS, JavaScript") : t("from layers on the canvas")}</dd>
					<dt>{t("ID for the API")}</dt>
					<dd>
						<code>{template.id}</code>
					</dd>
				</dl>
			</Section>

			{isCode ? (
				<Section title={t("Entrance and exit")}>
					<div className="ed-hint" data-code-transitions-hint>
						{t("A code animation enters and leaves by itself — its JavaScript does it, and the timing is read from that code.")}
					</div>
					<dl className="ed-facts">
						<dt>{t("Entrance")}</dt>
						<dd>
							{!hooks
								? t("detecting…")
								: hooks.show
									? t("animated by the code (onShow)")
									: t("instant: the code has no onShow")}
						</dd>
						<dt>{t("Exit")}</dt>
						<dd data-code-exit>
							{!hooks
								? t("detecting…")
								: hooks.hide
									? t("animated by the code, {ms} ms", { ms: exitMs })
									: t("instant: the code has no onHide")}
						</dd>
					</dl>
					{hooks?.hide ? (
						<div className="ed-hint">
							{t(
								"The exit is part of the “Hold” time: the animation starts leaving {ms} ms before it ends.",
								{ ms: exitMs },
							)}
						</div>
					) : null}
				</Section>
			) : (
				<Section title={t("Entrance and exit")}>
					<MotionTimeline
						template={template}
						focusLayerId={focusLayerId}
						onTemplate={onPatch}
						onLayer={onLayer}
					/>
				</Section>
			)}

			<Section title={t("Default playback")} defaultOpen={false}>
				<PlaybackFields
					playback={playback}
					template={template}
					scope="template"
					onChange={(patch) => onPatch({ playback: { ...playback, ...patch } })}
				/>
				<div className="ed-hint">
					{t("What the animation gets when it is placed on an out. After that each placement has its own settings.")}
				</div>
			</Section>
		</div>
	);
}

// ----------------------------------------------------------------- code dock

type CodeTab = "html" | "css" | "js" | "help";

const CODE_TABS: CodeTab[] = ["html", "css", "js", "help"];

/** The three languages are names, not words; only the reference tab is translated. */
function codeTabLabel(tab: CodeTab): string {
	if (tab === "html") return "HTML";
	if (tab === "css") return "CSS";
	if (tab === "js") return "JavaScript";
	return t("Reference");
}

/** What the runtime hands to a code animation. */
function CodeHelp() {
	return (
		<div className="ed-help">
			<dl>
				<dt>
					<code>vars("path", "fallback")</code>
				</dt>
				<dd>{t("a variable's value as a string; the second argument is used when it is empty")}</dd>
				<dt>
					<code>onData(fn)</code>
				</dt>
				<dd>{t("called at once and on every data change")}</dd>
				<dt>
					<code>data</code>
				</dt>
				<dd>{t("all variables as one object")}</dd>
				<dt>
					<code>root</code>
				</dt>
				<dd>{t("the animation's container")}</dd>
				<dt>
					<code>[data-bind="path"]</code>
				</dt>
				<dd>{t("the element's text updates by itself")}</dd>
				<dt>
					<code>onShow(fn)</code>
				</dt>
				<dd>{t("the animation is shown: play the entrance and start whatever runs while it is on air")}</dd>
				<dt>
					<code>onHide(fn, ms)</code>
				</dt>
				<dd>
					{tr("the animation is being hidden: play the exit; {ms} is how long the system waits for it", {
						ms: <code>ms</code>,
					})}
				</dd>
				<dt>
					<code>hideDone()</code>
				</dt>
				<dd>
					{tr("the exit is over, no need to wait out {ms}", { ms: <code>ms</code> })}
				</dd>
			</dl>
			<p>
				{tr(
					"{token} in HTML and CSS is filled in once, on load. For live values use {vars}, {onData} and {bind}.",
					{
						token: <code>{"{{path}}"}</code>,
						vars: <code>vars()</code>,
						onData: <code>onData()</code>,
						bind: <code>data-bind</code>,
					},
				)}
			</p>
			<p>
				{tr(
					"Only the code animates the entrance and the exit: without {show} and {hide} the animation appears and disappears instantly.",
					{ show: <code>onShow</code>, hide: <code>onHide</code> },
				)}
			</p>
		</div>
	);
}

/**
 * The code of a `kind: "code"` animation, docked under the canvas where a line
 * of code has room, next to a preview of the animation on its own.
 */
function CodeDock({
	template,
	data,
	onCode,
	onHooks,
	onResize,
	onResetSize,
}: {
	template: TitleTemplate;
	data: TitleData;
	onCode: (patch: Partial<CodeBlock>) => void;
	/** Called with the phases the previewed animation says it animates itself. */
	onHooks: (hooks: CodeHooks) => void;
	onResize: (edge: LayoutEdge, size: number) => void;
	onResetSize: (edge: LayoutEdge) => void;
}) {
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const [tab, setTab] = useState<CodeTab>("html");
	const [open, setOpen] = useState(true);
	const [nonce, setNonce] = useState(0);
	const doc = useCodeDocument(template, data, nonce);
	const box = useElementSize<HTMLDivElement>();
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const feedTimers = useTimerFeed(frameRef, template, data);

	// The preview runs the real runtime, so it reports the same hooks the out
	// page will get. Only this dock's own frame is listened to: the canvas
	// hosts frames of other animations.
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
			const message = event.data as {
				type?: string;
				show?: unknown;
				hide?: unknown;
				hideMs?: unknown;
			} | null;
			if (!message || message.type !== CODE_MESSAGES.hooks) return;
			onHooks({
				show: Boolean(message.show),
				hide: Boolean(message.hide),
				hideMs:
					typeof message.hideMs === "number" && Number.isFinite(message.hideMs)
						? message.hideMs
						: 0,
			});
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [onHooks]);

	const code = template.code ?? { html: "", css: "", js: "" };
	const fromFile = codeSource(template) === "file" && code.src ? code.src : "";
	// The preview is the animation at its design size, scaled to fit the box —
	// the same way the canvas and the out page show it.
	const scale =
		template.width > 0 && template.height > 0
			? Math.min(box.width / template.width, box.height / template.height)
			: 0;

	return (
		<div className="ed-dock">
			{open ? (
				<Splitter
					edge="dock"
					label={t("Height of the code dock")}
					title={t("Drag to resize · double-click to reset")}
					measure={() => bodyRef.current?.getBoundingClientRect().height ?? 0}
					onResize={onResize}
					onReset={onResetSize}
				/>
			) : null}
			<div className="ed-dock__bar">
				<div className="ed-tabs" role="tablist" aria-label={t("Animation code")}>
					{CODE_TABS.map((item) => (
						<button
							key={item}
							type="button"
							role="tab"
							aria-selected={open && tab === item}
							className={`ed-tab${open && tab === item ? " is-on" : ""}`}
							onClick={() => {
								setTab(item);
								setOpen(true);
							}}
						>
							{codeTabLabel(item)}
						</button>
					))}
				</div>
				{fromFile ? (
					<span className="ed-hint truncate" title={fromFile}>
						{tr("The code comes from the file {file}. HTML written here overrides the file.", {
							file: <code>{fromFile}</code>,
						})}
					</span>
				) : null}
				<span className="ed-spacer" />
				<IconButton
					icon={open ? "chevronDown" : "up"}
					label={open ? t("Collapse the code") : t("Expand the code")}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				/>
			</div>
			{/* Folded, not unmounted: the preview keeps running and reporting its hooks. */}
			<div className="ed-dock__body" hidden={!open} ref={bodyRef}>
				{tab === "help" ? (
					<CodeHelp />
				) : (
					<textarea
						className="ed-code"
						spellCheck={false}
						aria-label={codeTabLabel(tab)}
						value={code[tab] ?? ""}
						onChange={(event) => onCode({ [tab]: event.target.value })}
					/>
				)}
				<div className="ed-dock__preview">
					<div className="ed-code-preview" data-theme="dark" ref={box.ref}>
						{/* The iframe only exists once there is a document to show: an
						    iframe created with an empty `srcdoc` and filled in a moment
						    later sometimes keeps its initial about:blank and never
						    paints, which reads as "the preview is broken". */}
						{doc ? (
							<iframe
								ref={frameRef}
								onLoad={feedTimers}
								className="ed-preview-frame"
								title={t("Code animation preview")}
								sandbox="allow-scripts allow-same-origin"
								srcDoc={doc}
								style={{
									width: template.width,
									height: template.height,
									left: (box.width - template.width * scale) / 2,
									top: (box.height - template.height * scale) / 2,
									transform: `scale(${scale})`,
								}}
							/>
						) : null}
					</div>
					<div className="ed-dock__preview-foot">
						<span className="ed-hint">
							{t("Preview {size}", { size: `${template.width}×${template.height}` })}
						</span>
						<button
							type="button"
							className="ghost small"
							title={t("Play the entrance again")}
							onClick={() => setNonce((value) => value + 1)}
						>
							<Icon name="restart" size={14} />
							{t("Replay")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

// --------------------------------------------------------------------- app

/** What the inspector is showing: the layer, the placement or the animation. */
type InspectorTab = "layer" | "placement" | "template";

const INSPECTOR_TAB_LABEL: Record<InspectorTab, Phrase> = {
	layer: N_("Layer"),
	placement: N_("Placement"),
	template: N_("Animation"),
};

export function EditorApp() {
	const templates = useTemplates();
	const outs = useOuts();
	const data = useTitleData();
	const allTimers = useAllTimers();
	const runtime = useRuntime();
	const selection = useSelection();
	const active = useActiveTitle();
	useLang();

	const [outId, setOutId] = useState<string>("");
	const [activeItemId, setActiveItemId] = useState<string | null>(null);
	const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
	// Live playback preview of the selected video layer (editor panel only).
	const [previewPlaying, setPreviewPlaying] = useState(false);
	const [restartToken, setRestartToken] = useState(0);
	const [libraryId, setLibraryId] = useState<string | null>(null);
	const [draft, setDraft] = useState<TitleTemplate | null>(null);
	const [dirty, setDirty] = useState(false);
	const [flash, setFlash] = useState("");
	/** The crop tool is on: the canvas edits the active placement's window. */
	const [cropMode, setCropMode] = useState(false);
	const layout = useEditorLayout();
	const deskFull = useDeskFullscreen();
	const leftRef = useRef<HTMLDivElement | null>(null);
	const rightRef = useRef<HTMLDivElement | null>(null);
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>("placement");
	/** What the edited code animation animates itself; `null` until its preview reports. */
	const [codeHooks, setCodeHooks] = useState<CodeHooks | null>(null);

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
		setCodeHooks(null);
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

	// Selecting another layer always drops back to the frozen frame: the
	// operator must never be surprised by sudden playback.
	useEffect(() => {
		setPreviewPlaying(false);
	}, [selectedLayerId]);

	// The inspector follows the selection: a layer brings up its own tab, and
	// letting go of it falls back to the placement.
	useEffect(() => {
		setInspectorTab((tab) =>
			selectedLayerId ? "layer" : tab === "layer" ? "placement" : tab,
		);
	}, [selectedLayerId]);

	const confirmDiscard = useCallback((): boolean => {
		if (!dirtyRef.current) return true;
		return window.confirm(t("There are unsaved changes. Continue without saving?"));
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

	// Keep `code.exitMs` equal to what the code itself declares. A mismatch is
	// a real unsaved difference (the scheduler would start the exit at the
	// wrong moment), so it goes through the draft like any other edit.
	useEffect(() => {
		if (!codeHooks || !draft || draft.kind !== "code") return;
		const stored = draft.code?.exitMs ?? 0;
		const wanted = declaredExitMs(codeHooks, stored);
		if (wanted === stored) return;
		mutate((template) => ({
			...template,
			code: { ...(template.code ?? { html: "", css: "", js: "" }), exitMs: wanted },
		}));
	}, [codeHooks, draft, mutate]);

	// ------------------------------------------------------ video preview

	const togglePreview = useCallback(() => {
		setPreviewPlaying((value) => !value);
	}, []);

	const restartPreview = useCallback(() => {
		setRestartToken((value) => value + 1);
	}, []);

	// A freshly uploaded clip on the selected layer may start playing once so
	// the operator immediately sees what landed.
	const handleUploaded = useCallback(() => {
		setPreviewPlaying(true);
	}, []);

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
		notify(t("Played"));
	};

	const removeItemFromOut = (itemId: string) => {
		if (!out) return;
		if (itemId === activeItemId && dirty) {
			if (!window.confirm(t("Remove the animation from the out? Unsaved changes will be lost."))) {
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
		notify(t("Removed from the out"));
	};

	const fitItemToOut = (item: OutItem) => {
		if (!out) return;
		const template = getTemplate(item.templateId);
		if (!template || template.width <= 0) return;
		updateItem(out.id, item.id, { scale: round(out.width / template.width, 4) });
	};

	// -------------------------------------------------------------- crop tool

	/**
	 * The crop tool edits the visible window of the active placement, so it is
	 * offered exactly when there is a placement with a template to measure.
	 */
	const canCrop = Boolean(activeItem && getTemplate(activeItem.templateId));

	// Losing the placement loses the tool with it — there is nothing to crop.
	useEffect(() => {
		if (!canCrop) setCropMode(false);
	}, [canCrop]);

	const setCrop = (crop: OutItem["crop"]) => {
		if (!activeItem || !out) return;
		updateItem(out.id, activeItem.id, { crop });
	};

	const toggleCropMode = () => {
		if (!canCrop) return;
		setCropMode((value) => {
			const next = !value;
			if (next) {
				setSelectedLayerId(null);
				setInspectorTab("placement");
			}
			return next;
		});
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
		notify(t("Placed on the out"));
	};

	// ------------------------------------------------------------- templates

	const startNewAnimation = (): { item: OutItem; template: TitleTemplate } | null => {
		if (!out) return null;
		const base = newTemplate("layers");
		const saved = saveTemplate({
			...base,
			name: t("New animation"),
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

	const addLayer = (type: LayerType, shape?: (layer: Layer) => Layer) => {
		let working = draft && draft.kind === "layers" ? draft : null;
		if (!working) {
			if (editingTemplateId && !confirmDiscard()) return;
			const started = startNewAnimation();
			if (!started) return;
			working = started.template;
		}
		const layer = shape ? shape(makeLayer(type, 1)) : makeLayer(type, 1);
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
		const saved = saveTemplate({
			...newTemplate(kind),
			name: kind === "code" ? t("New code animation") : t("New animation"),
		});
		if (out) {
			const item = addItem(out.id, saved.id);
			if (item) setActiveItemId(item.id);
		}
		setLibraryId(null);
		setSelectedLayerId(null);
		notify(kind === "code" ? t("Code animation created") : t("Animation created"));
	};

	const createFromExample = (example: GalleryExample) => {
		if (!confirmDiscard()) return;
		const saved = addExample(example, getLang());
		if (out) {
			// Examples are drawn for a 1920-wide frame: scale them with the out,
			// so they keep their proportions on any size.
			const item = addItem(out.id, saved.id, {
				x: example.place?.x ?? 0,
				y: example.place?.y ?? 0,
				scale: round(out.width / 1920, 4),
			});
			if (item) setActiveItemId(item.id);
		}
		setLibraryId(null);
		setSelectedLayerId(null);
		notify(t("Example added: {name}", { name: saved.name }));
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
		notify(t("Duplicate: {name}", { name: copy.name }));
	};

	const removeTemplate = (id: string) => {
		const template = getTemplate(id);
		if (!template) return;
		if (!window.confirm(t("Delete “{name}”?", { name: template.name }))) return;
		if (editingTemplateId === id) {
			setActiveItemId(null);
			setLibraryId(null);
			setDraft(null);
			setDirty(false);
			setSelectedLayerId(null);
		}
		deleteTemplate(id);
		notify(t("Animation deleted"));
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
		// Saving rebuilds the animation wherever it is on air, so it only
		// happens when there is something to save.
		if (dirtyRef.current) {
			const saved = persist();
			if (saved) return saved;
		}
		if (draftRef.current) return draftRef.current;
		if (editingTemplateId) return getTemplate(editingTemplateId) ?? null;
		return null;
	};

	// Play and "on air" act on the selected placement — the same play and the
	// same switch Control has. Only an animation that is not on this out falls
	// back to the manual show.
	const preview = () => {
		const target = resolveForAction();
		if (!target) return;
		if (out && activeItem) triggerItem(out.id, activeItem.id);
		else triggerTemplate(target.id, outId || null);
		notify(t("Played on {name}", { name: out ? out.name : "out" }));
	};

	const showOnOut = () => {
		const target = resolveForAction();
		if (!target) return;
		if (out && activeItem) updateItem(out.id, activeItem.id, { held: true });
		else showTitle(target.id, { outId: outId || null });
		notify(t("On air"));
	};

	const hideOnOut = () => {
		if (out && activeItem) updateItem(out.id, activeItem.id, { held: false });
		else hideTitle({ outId: outId || null });
		notify(t("Taken off air"));
	};

	// Escape always leaves the crop tool, whatever has focus. It is caught on
	// the way down and marked as used, so that on a desk that fills the panel
	// the same press does not leave full screen as well.
	useEffect(() => {
		if (!cropMode) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setCropMode(false);
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [cropMode]);

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

	const dataPaths = useMemo(
		() => [...flattenData(data).map((row) => row.path), ...timerPaths(allTimers)],
		[data, allTimers],
	);
	// The canvas shows the timers ticking, as the out will, while a layer of an
	// animation on it shows one. A code animation is fed by its own frame.
	const previewUsesTimers = useMemo(
		() =>
			[draft, ...items.map((item) => templates.find((template) => template.id === item.templateId))].some(
				(template) => template?.kind === "layers" && layersUseTimers(template),
			),
		[draft, items, templates],
	);
	const liveData = useLiveData(data, previewUsesTimers);
	const addTimerLayer = (key: string) => addLayer("text", (layer) => timerLayer(layer, key));
	const timerItem = timerMenuItem(allTimers, addTimerLayer, () => {
		void createTimer({ name: t("Timer {n}", { n: allTimers.length + 1 }) })
			.then((result) => {
				if (result.timer) addTimerLayer(result.timer.key);
			})
			.catch((error: unknown) => window.alert(String((error as Error)?.message ?? error)));
	});
	const templatesLoaded = getDb().templates.value !== undefined;
	const outsLoaded = getDb().outs.value !== undefined;
	const draftLayers = draft?.layers ?? [];
	const selectedLayer = draftLayers.find((layer) => layer.id === selectedLayerId) ?? null;
	const playingIds = out ? runtime.playing?.[out.id] ?? [] : [];
	const placedIds = useMemo(() => new Set(items.map((item) => item.templateId)), [items]);

	const canAct = Boolean(draft || editingTemplateId);
	// "On air" follows the placement's own switch; an animation that is not on
	// this out can only be on air through the manual show.
	const onAir = activeItem
		? Boolean(activeItem.held)
		: Boolean(
				active.visible &&
					editingTemplateId &&
					active.templateId === editingTemplateId &&
					(!active.outId || active.outId === outId),
			);
	// A code animation has no layers, so it has no layer tab either.
	const tabs: InspectorTab[] =
		draft?.kind === "layers" ? ["layer", "placement", "template"] : ["placement", "template"];
	const tab = tabs.includes(inspectorTab) ? inspectorTab : "placement";

	// The tools that work on the canvas. They sit in the toolbar, and move onto
	// the desk when it goes full screen: there the toolbar is out of sight.
	const canvasTools = (
		<>
			<Menu label={t("Add layer")} items={layerMenu(addLayer, timerItem)}>
				<Icon name="plus" size={14} />
				{t("Layer")}
				<Icon name="chevronDown" size={12} />
			</Menu>
			<button
				type="button"
				className={`ed-tool${cropMode ? " is-active" : ""}`}
				onClick={toggleCropMode}
				disabled={!canCrop}
				data-crop-toggle
				title={
					canCrop
						? t("A frame over the selected animation: everything outside it is hidden")
						: t("Select an animation on the out first")
				}
			>
				<Icon name="crop" size={14} />
				{t("Crop")}
			</button>
		</>
	);
	const cropTools =
		cropMode && activeItem ? (
			<>
				<span className="ed-hint" data-crop-hint>
					{t("The frame is the visible part. Drag its edges and corners.")}
				</span>
				{activeItem.crop ? (
					<button
						type="button"
						className="ghost small"
						onClick={() => setCrop(undefined)}
						data-crop-reset
					>
						{t("Reset")}
					</button>
				) : null}
				<button type="button" className="small" onClick={() => setCropMode(false)}>
					{t("Done")}
				</button>
			</>
		) : null;

	return (
		<div className="ed-root">
			<div className="ed-toolbar">
				<label className="ed-toolbar__out">
					Out
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
				</label>
				<IconButton
					icon="link"
					label={out ? t("Copy the out's address for OBS") : t("Create an out first")}
					disabled={!out}
					onClick={() => {
						if (!out) return;
						void copyText(absoluteOutUrl(out.id)).then(() => notify(t("Address for OBS copied")));
					}}
				/>
				<span className="ed-vline" />
				{deskFull.active ? null : canvasTools}
				<IconButton
					className={deskFull.active ? "is-on" : undefined}
					icon={deskFull.active ? "collapse" : "expand"}
					label={deskFull.active ? t("Exit full screen") : t("The desk in full screen")}
					onClick={deskFull.toggle}
					disabled={!out}
				/>
				{deskFull.active ? null : cropTools}
				<span className="ed-spacer" />
				{dirty ? <span className="ed-chip is-dirty">{t("Unsaved")}</span> : null}
				<button
					type="button"
					onClick={preview}
					disabled={!canAct || onAir}
					title={
						onAir
							? t("The animation is already on air — take it off first")
							: t("Save the changes and play once on this out")
					}
				>
					<Icon name="play" size={14} />
					{t("Play")}
				</button>
				<button
					type="button"
					className={`ed-air${onAir ? " is-live" : ""}`}
					onClick={onAir ? hideOnOut : showOnOut}
					disabled={!canAct}
					title={
						onAir
							? t("Take the animation off air on this out")
							: t("Save the changes and keep it on this out until you take it off")
					}
				>
					{onAir ? t("Take off air") : t("Go on air")}
				</button>
				<button type="button" className="primary" onClick={persist} disabled={!draft || !dirty}>
					{t("Save")}
				</button>
				<ThemeSwitch />
				<LangSwitch />
			</div>

			<div className="ed-main" style={layout.style}>
				<div className="ed-side" ref={leftRef}>
					{out ? (
						<OutItemsList
							out={out}
							templates={templates}
							draft={draft}
							activeItemId={activeItemId}
							playing={playingIds}
							onActivate={handleSelectItem}
							onMove={moveItemInOut}
							onTrigger={triggerItemOnOut}
							onRemove={removeItemFromOut}
						/>
					) : null}

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
							timerItem={timerItem}
						/>
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
						onExample={createFromExample}
						onDuplicate={duplicate}
						onDelete={removeTemplate}
						onRename={renameTemplate}
					/>
				</div>

				<div className="ed-stage">
					{out ? (
						<EditorCanvas
							out={out}
							templates={templates}
							draft={draft}
							activeItemId={activeItemId}
							selectedLayerId={selectedLayerId}
							cropMode={cropMode}
							liveIds={playingIds}
							unsaved={dirty}
							liveDraft={!activeItem && onAir}
							previewPlaying={previewPlaying}
							restartToken={restartToken}
							data={liveData}
							selection={selection}
							onSelectItem={handleSelectItem}
							onSelectLayer={setSelectedLayerId}
							onLayerChange={updateLayer}
							onItemChange={patchItem}
							deskRef={deskFull.deskRef}
							deskFull={deskFull.active}
							deskFilled={deskFull.filled}
							onToggleDeskFull={deskFull.toggle}
							deskTools={
								deskFull.active ? (
									<>
										{canvasTools}
										{cropTools}
									</>
								) : null
							}
						/>
					) : (
						<div className="ed-center" data-theme="dark">
							<div className="ed-empty">
								<h2>{outsLoaded ? t("No outs yet") : t("Loading…")}</h2>
								{outsLoaded ? (
									<p>
										{t("The editor's canvas is an out. Create the first one on the Titles & Outs tab.")}
									</p>
								) : null}
							</div>
						</div>
					)}

					{draft && draft.kind === "code" ? (
						<CodeDock
							template={draft}
							data={data}
							onHooks={setCodeHooks}
							onResize={layout.resize}
							onResetSize={layout.reset}
							onCode={(patch) =>
								updateTemplate({
									code: {
										...(draft.code ?? { html: "", css: "", js: "" }),
										...patch,
									},
								})
							}
						/>
					) : null}

					{flash ? (
						<div className="ed-flash" role="status">
							{flash}
						</div>
					) : null}
				</div>

				<Splitter
					edge="left"
					label={t("Width of the left bar")}
					title={t("Drag to resize · double-click to reset")}
					measure={() => leftRef.current?.getBoundingClientRect().width ?? 0}
					onResize={layout.resize}
					onReset={layout.reset}
				/>
				<Splitter
					edge="right"
					label={t("Width of the right bar")}
					title={t("Drag to resize · double-click to reset")}
					measure={() => rightRef.current?.getBoundingClientRect().width ?? 0}
					onResize={layout.resize}
					onReset={layout.reset}
				/>

				<div className="ed-side ed-side--right" ref={rightRef}>
					{draft ? (
						<>
							<div className="ed-tabs ed-tabs--fill" role="tablist" aria-label={t("Inspector")}>
								{tabs.map((item) => (
									<button
										key={item}
										type="button"
										role="tab"
										aria-selected={tab === item}
										className={`ed-tab${tab === item ? " is-on" : ""}`}
										onClick={() => setInspectorTab(item)}
									>
										{t(INSPECTOR_TAB_LABEL[item])}
									</button>
								))}
							</div>

							{tab === "layer" ? (
								selectedLayer ? (
									<LayerInspector
										layer={selectedLayer}
										data={liveData}
										selection={selection}
										dataPaths={dataPaths}
										previewPlaying={previewPlaying}
										onPatch={(patch) => updateLayer(selectedLayer.id, patch)}
										onStyle={(patch) => updateStyle(selectedLayer.id, patch)}
										onTogglePreview={togglePreview}
										onRestartPreview={restartPreview}
										onUploaded={handleUploaded}
									/>
								) : (
									<p className="ed-hint ed-pad">
										{t("Select a layer on the canvas or in the list on the left — its properties appear here.")}
									</p>
								)
							) : null}

							{tab === "placement" ? (
								activeItem && out ? (
									<PlacementInspector
										out={out}
										item={activeItem}
										template={draft}
										onPatch={(patch) => patchItem(activeItem.id, patch)}
										onPlayback={(patch) => patchItemPlayback(activeItem.id, patch)}
										onRemove={() => removeItemFromOut(activeItem.id)}
										onFitOut={() => fitItemToOut(activeItem)}
										onCrop={() => {
											if (!cropMode) toggleCropMode();
										}}
									/>
								) : (
									<div className="ed-pad col">
										<p className="ed-hint">
											{t("This animation is not on the selected out yet. Place it to set its position and playback.")}
										</p>
										<button
											type="button"
											className="ed-start"
											onClick={() => placeTemplate(draft.id)}
											disabled={!out}
										>
											<Icon name="plus" size={14} />
											{t("Place on the out")}
										</button>
									</div>
								)
							) : null}

							{tab === "template" ? (
								<TemplateSettings
									template={draft}
									hooks={codeHooks}
									focusLayerId={selectedLayerId}
									onPatch={updateTemplate}
									onLayer={updateLayer}
								/>
							) : null}
						</>
					) : (
						<p className="ed-hint ed-pad">
							{outsLoaded && templatesLoaded
								? t("Select an animation on the left, or create one in the library.")
								: t("Loading…")}
						</p>
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
