/**
 * notGT editor — small UI atoms + browser hooks.
 *
 * Deliberately dependency-free (React only): everything here is shared by the
 * canvas and the sidebar panels of the visual editor.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { getByPath, interpolate } from "../../shared/binding";
import {
	BUNDLE_NAME,
	type Layer,
	type LayerType,
	type TitleData,
	type TransitionType,
	type VariableSelection,
} from "../../shared/types";

// ------------------------------------------------------------------ helpers

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** Rounds away float noise before writing a percent back into the replicant. */
export function round(value: number, digits = 2): number {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function stringifyValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

/**
 * Same rules as the graphics runtime (`resolveLayerText`): an explicit
 * `binding` wins, otherwise `{{path}}` tokens are interpolated. The raw string
 * is kept when a token resolves to nothing, so the operator still sees it.
 */
export function resolveText(
	layer: Layer,
	data: TitleData,
	selection: VariableSelection = {},
): string {
	if (layer.binding) {
		const direct = stringifyValue(getByPath(data, layer.binding, selection));
		if (direct !== "") return direct;
	}
	return interpolate(layer.text ?? "", data, selection);
}

export function sortByZ(layers: Layer[]): Layer[] {
	return [...layers].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
}

/** Image src is resolved the same way the graphics page would resolve it. */
export function resolveAssetUrl(src: string): string {
	const value = src.trim();
	if (!value) return "";
	if (/^(https?:)?\/\//i.test(value)) return value;
	if (/^(data|blob):/i.test(value)) return value;
	if (value.startsWith("/")) return value;
	return `/bundles/${BUNDLE_NAME}/graphics/${value.replace(/^\.\//, "")}`;
}

export function layerDisplayName(layer: Layer): string {
	if (layer.name && layer.name.trim()) return layer.name.trim();
	if (layer.type === "text") {
		const text = (layer.text ?? "").trim();
		if (text) return text.length > 28 ? `${text.slice(0, 28)}…` : text;
	}
	return LAYER_TYPE_LABEL[layer.type];
}

// ------------------------------------------------------------------ constants

export const LAYER_TYPE_LABEL: Record<LayerType, string> = {
	text: "Текст",
	shape: "Фигура",
	image: "Картинка",
	gif: "GIF",
	video: "видео",
};

export const TRANSITION_TYPES: TransitionType[] = [
	"none",
	"fade",
	"slide-left",
	"slide-right",
	"slide-up",
	"slide-down",
	"scale",
	"wipe-left",
	"wipe-right",
];

export const TRANSITION_LABEL: Record<TransitionType, string> = {
	none: "нет",
	fade: "fade — растворение",
	"slide-left": "slide-left — выезд слева",
	"slide-right": "slide-right — выезд справа",
	"slide-up": "slide-up — выезд снизу",
	"slide-down": "slide-down — выезд сверху",
	scale: "scale — масштаб",
	"wipe-left": "wipe-left — шторка влево",
	"wipe-right": "wipe-right — шторка вправо",
};

export const FONT_FAMILIES: string[] = [
	"Inter, 'Segoe UI', Roboto, Arial, sans-serif",
	"Inter, Arial, sans-serif",
	"Roboto, Arial, sans-serif",
	"'Segoe UI', Tahoma, sans-serif",
	"Arial, Helvetica, sans-serif",
	"Georgia, 'Times New Roman', serif",
	"'Times New Roman', serif",
	"'Courier New', monospace",
	"ui-monospace, Menlo, Consolas, monospace",
];

// -------------------------------------------------------------------- hooks

/** Loads an image for Konva. Missing/blank src simply yields `undefined`. */
export function useHtmlImage(src: string): HTMLImageElement | undefined {
	const [image, setImage] = useState<HTMLImageElement | undefined>(undefined);

	useEffect(() => {
		if (!src) {
			setImage(undefined);
			return;
		}
		let alive = true;
		const img = new window.Image();
		img.onload = () => {
			if (alive) setImage(img);
		};
		img.onerror = () => {
			if (alive) setImage(undefined);
		};
		img.src = src;
		return () => {
			alive = false;
			img.onload = null;
			img.onerror = null;
		};
	}, [src]);

	return image;
}

/**
 * Loads a *paused* video element for Konva's `image` prop.
 *
 * The editor never plays clips: the element is only used to paint a single
 * frame, so it is muted/playsinline, `preload="metadata"` and paused as soon as
 * a frame is available. A missing, undecodable or 404 src simply yields
 * `undefined`, letting the caller draw a placeholder instead of crashing.
 *
 * `frame` is bumped on every media event that may produce a new picture
 * (`loadedmetadata` / `loadeddata` / `seeked`) so the canvas can force a redraw
 * — Konva does not observe a video element's frames by itself.
 */
export function useHtmlVideo(
	src: string,
	options: { loop?: boolean; muted?: boolean; rate?: number } = {},
): { video: HTMLVideoElement | undefined; frame: number } {
	const { loop = true, muted = true, rate = 1 } = options;
	const [video, setVideo] = useState<HTMLVideoElement | undefined>(undefined);
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		if (!src) {
			setVideo(undefined);
			return;
		}
		let alive = true;
		const el = document.createElement("video");
		el.muted = muted;
		el.defaultMuted = muted;
		el.playsInline = true;
		el.loop = loop;
		el.autoplay = false;
		el.controls = false;
		el.preload = "metadata";
		if (Number.isFinite(rate) && rate > 0) el.playbackRate = rate;

		const bump = () => {
			if (alive) setFrame((value) => value + 1);
		};
		const onMeta = () => {
			if (!alive) return;
			// Nudge off frame 0 so the browser actually decodes a picture, then
			// stop: the editor must not consume CPU playing the clip.
			try {
				if (el.duration > 0) el.currentTime = Math.min(0.1, el.duration / 2);
			} catch {
				// Not seekable yet — `loadeddata` will still yield frame 0.
			}
			setVideo(el);
			bump();
		};
		const onData = () => {
			if (!alive) return;
			setVideo(el);
			el.pause();
			bump();
		};
		const onError = () => {
			if (alive) setVideo(undefined);
		};

		el.addEventListener("loadedmetadata", onMeta);
		el.addEventListener("loadeddata", onData);
		el.addEventListener("seeked", bump);
		el.addEventListener("error", onError);
		el.src = src;
		el.load();

		return () => {
			alive = false;
			el.removeEventListener("loadedmetadata", onMeta);
			el.removeEventListener("loadeddata", onData);
			el.removeEventListener("seeked", bump);
			el.removeEventListener("error", onError);
			el.pause();
			el.removeAttribute("src");
			try {
				el.load();
			} catch {
				// Detached element — nothing to release.
			}
		};
	}, [src, loop, muted, rate]);

	return { video, frame };
}

/** Tracks the content-box size of an element (for "fit to available area"). */
export function useElementSize<T extends HTMLElement>(): {
	ref: RefObject<T>;
	width: number;
	height: number;
} {
	const ref = useRef<T | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return { ref, width: size.width, height: size.height };
}

// --------------------------------------------------------------- form atoms

export function Field({ label, children }: { label?: string; children: ReactNode }) {
	return (
		<div className="ed-field">
			{label ? <span className="ed-field__label">{label}</span> : null}
			{children}
		</div>
	);
}

export function TextField({
	label,
	value,
	onChange,
	placeholder,
	mono,
}: {
	label?: string;
	value: string | undefined;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<Field label={label}>
			<input
				type="text"
				className={mono ? "ed-mono" : undefined}
				value={value ?? ""}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	);
}

/**
 * Forgiving number input: the local draft keeps whatever the operator typed
 * (including empty / garbage), and only a finite number is committed.
 */
export function NumField({
	label,
	value,
	onChange,
	step = 1,
	min,
	max,
	suffix,
	title,
}: {
	label?: string;
	value: number | undefined;
	onChange: (value: number) => void;
	step?: number;
	min?: number;
	max?: number;
	suffix?: string;
	title?: string;
}) {
	const [draft, setDraft] = useState(value === undefined ? "" : String(value));
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(value === undefined ? "" : String(value));
	}, [value, focused]);

	const text = suffix ? (label ? `${label} (${suffix})` : suffix) : label;

	return (
		<Field label={text}>
			<input
				type="number"
				title={title}
				step={step}
				value={draft}
				onFocus={() => setFocused(true)}
				onBlur={() => {
					setFocused(false);
					setDraft(value === undefined ? "" : String(value));
				}}
				onChange={(event) => {
					const raw = event.target.value;
					setDraft(raw);
					if (raw.trim() === "") return;
					const parsed = Number(raw);
					if (!Number.isFinite(parsed)) return;
					const next = min !== undefined || max !== undefined
						? clamp(parsed, min ?? -Number.MAX_SAFE_INTEGER, max ?? Number.MAX_SAFE_INTEGER)
						: parsed;
					onChange(next);
				}}
			/>
		</Field>
	);
}

/** Colour swatch + free-form text (so `rgba(...)` and `transparent` work). */
export function ColorField({
	label,
	value,
	onChange,
}: {
	label?: string;
	value: string | undefined;
	onChange: (value: string) => void;
}) {
	const current = value ?? "";
	const swatch = /^#[0-9a-f]{6}$/i.test(current) ? current : "#ffffff";
	return (
		<Field label={label}>
			<div className="ed-color">
				<input
					type="color"
					value={swatch}
					onChange={(event) => onChange(event.target.value)}
				/>
				<input
					type="text"
					value={current}
					placeholder="transparent"
					onChange={(event) => onChange(event.target.value)}
				/>
				{current ? (
					<button
						type="button"
						className="ed-icon-btn"
						title="Очистить"
						onClick={() => onChange("")}
					>
						✕
					</button>
				) : null}
			</div>
		</Field>
	);
}

export function SelectField<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label?: string;
	value: T | undefined;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		<Field label={label}>
			<select
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value as T)}
			>
				{value === undefined || value === "" ? <option value="">—</option> : null}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</Field>
	);
}

export function CheckField({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="ed-check">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}

export function Section({
	title,
	children,
	defaultOpen = true,
}: {
	title: string;
	children: ReactNode;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="ed-section">
			<button
				type="button"
				className="ed-section__head"
				onClick={() => setOpen((value) => !value)}
			>
				<span className="ed-caret">{open ? "▾" : "▸"}</span>
				<span>{title}</span>
			</button>
			{open ? <div className="ed-section__body">{children}</div> : null}
		</div>
	);
}

/** Inline rename committed on blur / Enter, reverted on Escape. */
export function InlineName({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);

	useEffect(() => {
		if (!editing) setDraft(value);
	}, [value, editing]);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== value) onChange(next);
		else setDraft(value);
	};

	if (!editing) {
		return (
			<span
				className="ed-inline-name"
				title="Двойной клик — переименовать"
				onDoubleClick={() => setEditing(true)}
			>
				{value || placeholder || "—"}
			</span>
		);
	}

	return (
		<input
			className="ed-inline-name ed-inline-name--edit"
			autoFocus
			value={draft}
			placeholder={placeholder}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					event.preventDefault();
					setDraft(value);
					setEditing(false);
				}
			}}
		/>
	);
}
