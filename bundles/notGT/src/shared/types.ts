/**
 * notGT shared domain model.
 *
 * This module is imported by the extension (Node), the dashboard panels (browser)
 * and the graphics runtime (browser/CEF). Keep it free of any runtime dependency.
 */

export const BUNDLE_NAME = "notGT";

/** Replicant names, kept in one place so every context agrees. */
export const REPLICANTS = {
	/** All title/animation templates. Persistent. */
	templates: "templates",
	/** All outs (browser-source render targets) and the animations placed on them. Persistent. */
	outs: "outs",
	/** Named variable values, keyed by binding path (`speaker.name`). Persistent. */
	titleData: "titleData",
	/** Manual "program" state driven by the dashboard / Companion. Persistent. */
	activeTitle: "activeTitle",
	/** Derived, volatile playback state. Not persistent. */
	runtime: "runtime",
	/** Bookkeeping (first-run seeding, schema version). Persistent. */
	meta: "meta",
} as const;

export interface MetaState {
	initialized: boolean;
	schemaVersion: number;
}

/** Socket messages used for one-shot triggers (state lives in replicants). */
export const MESSAGES = {
	/** fire a one-shot animation: { templateId, outId?, data? } */
	trigger: "trigger",
	/** force an out to refresh itself */
	refresh: "refresh",
} as const;

export type LayerType = "text" | "image" | "gif" | "shape";

export interface LayerStyle {
	/* typography */
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: number | string;
	fontStyle?: "normal" | "italic";
	color?: string;
	align?: "left" | "center" | "right";
	verticalAlign?: "top" | "middle" | "bottom";
	lineHeight?: number;
	letterSpacing?: number;
	textTransform?: "none" | "uppercase" | "lowercase";
	/* box */
	padding?: number;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
	/* text outline + shadow */
	textStrokeColor?: string;
	textStrokeWidth?: number;
	shadowColor?: string;
	shadowBlur?: number;
	shadowOffsetX?: number;
	shadowOffsetY?: number;
	/* shared */
	opacity?: number;
	rotation?: number;
}

export interface Layer {
	id: string;
	name?: string;
	type: LayerType;
	/** Left edge, in percent of the template canvas (0-100). Negative allowed. */
	x: number;
	/** Top edge, in percent of the template canvas (0-100). Negative allowed. */
	y: number;
	/** Width, in percent of the template canvas. `undefined` = auto (text). */
	width?: number;
	/** Height, in percent of the template canvas. `undefined` = auto. */
	height?: number;
	/** `text` layers: literal text, may contain {{bindings}}. Ignored when `binding` is set. */
	text?: string;
	/** Binding path whose value is used as the text (`speaker.name`). */
	binding?: string;
	/** `image`/`gif` layers: src. Absolute URL, `/assets/<bundle>/<file>` or bundle-relative. */
	src?: string;
	/** `shape` layers. */
	shape?: "rect" | "ellipse";
	style: LayerStyle;
	z: number;
	locked?: boolean;
	hidden?: boolean;
}

export type TransitionType =
	| "none"
	| "fade"
	| "slide-left"
	| "slide-right"
	| "slide-up"
	| "slide-down"
	| "scale"
	| "wipe-left"
	| "wipe-right";

export interface Transition {
	type: TransitionType;
	durationMs: number;
	easing?: string;
}

/** How an animation behaves when it is placed on an out. */
export interface PlaybackConfig {
	/** `once` = only when triggered; `loop` = repeats every `intervalMs`. */
	mode: "once" | "loop";
	/** Period between two plays, ms. Only meaningful for `loop`. */
	intervalMs: number;
	/** How long the animation stays fully visible per play, ms. */
	holdMs: number;
	/** Start looping automatically when the extension boots. */
	autoStart: boolean;
}

/** Code-authored animation (`kind: "code"`). */
export interface CodeBlock {
	html: string;
	css: string;
	js: string;
	/**
	 * Optional path to an animation file served by NodeCG, e.g.
	 * `/bundles/notGT/graphics/animations/ticker.html`. Used only while
	 * `html` is empty — as soon as the operator writes HTML in the GUI, the
	 * inline code takes over (fork-on-edit).
	 */
	src?: string;
}

export type TemplateKind = "layers" | "code";

export interface TitleTemplate {
	id: string;
	name: string;
	kind: TemplateKind;
	/** Design-space size in px. Layers are positioned in percent of this box. */
	width: number;
	height: number;
	/** Used when `kind === "layers"`. */
	layers: Layer[];
	/** Used when `kind === "code"`. */
	code?: CodeBlock;
	inTransition: Transition;
	outTransition: Transition;
	playback: PlaybackConfig;
	createdAt: number;
	updatedAt: number;
}

/** An animation placed on an out. */
export interface OutItem {
	id: string;
	templateId: string;
	/** Left/top of the animation box, percent of the out stage. */
	x: number;
	y: number;
	/** Scale applied to the template's design box. */
	scale: number;
	/** Overrides the template's own playback config when set. */
	playback: PlaybackConfig;
	enabled: boolean;
	order: number;
}

/** A render target = one OBS Browser Source URL (`out.html?out=<id>`). */
export interface Out {
	id: string;
	name: string;
	/** Design size of the stage in px; used for the dashboard preview and the out page. */
	width: number;
	height: number;
	items: OutItem[];
	createdAt: number;
	updatedAt: number;
}

export type TitleData = Record<string, unknown>;

export interface ActiveTitleState {
	templateId: string | null;
	visible: boolean;
	/** Target out. `null` = every out renders it. */
	outId: string | null;
	/** Per-show overrides merged over the global titleData. */
	data: TitleData;
	/** Free-form caption for feedback screens. */
	label?: string;
	updatedAt: number;
}

/** Volatile playback state, recomputed by the extension. */
export interface RuntimeState {
	/** outId -> set of OutItem ids that are currently playing. */
	playing: Record<string, string[]>;
	/**
	 * Play counter per `${outId}:${itemId}`. Bumped every time an animation is
	 * (re)started, so graphics can restart the entrance animation even when the
	 * animation is already on screen. Using a replicant instead of a socket
	 * message keeps the extension from ever looping back into itself.
	 */
	triggers: Record<string, number>;
	/** Monotonic counter, bumped on any change, for cheap change detection. */
	revision: number;
}

/** Shape returned by `GET /api/state` — this is what Companion polls. */
export interface PublicState {
	active: ActiveTitleState;
	/** Flattened mirrors of `active`, so Companion can bind a JSON path directly. */
	activeTemplateId: string | null;
	activeVisible: boolean;
	activeOutId: string | null;
	playing: Record<string, string[]>;
	revision: number;
	outs?: Array<{ id: string; name: string; width: number; height: number; url: string }>;
	templates?: Array<{ id: string; name: string; kind: TemplateKind }>;
}

export function newId(prefix = "id"): string {
	const uuid =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: Math.random().toString(36).slice(2) + Date.now().toString(36);
	return `${prefix}_${uuid.replace(/-/g, "").slice(0, 12)}`;
}

export function slugify(input: string, fallback = "out"): string {
	const slug = input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

export function defaultTransition(): Transition {
	return { type: "fade", durationMs: 350, easing: "ease-out" };
}

export function defaultPlayback(): PlaybackConfig {
	return { mode: "once", intervalMs: 10_000, holdMs: 6_000, autoStart: false };
}
