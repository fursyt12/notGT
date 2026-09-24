import { getByPath, interpolate } from "../shared/binding";
import type {
	Layer,
	LayerStyle,
	TitleData,
	VariableSelection,
} from "../shared/types";

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

/** Value of a text layer: explicit `binding` first, then `{{...}}` interpolation. */
export function resolveLayerText(
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

export function createLayerElement(layer: Layer): HTMLElement {
	const el =
		layer.type === "image" || layer.type === "gif"
			? document.createElement("img")
			: layer.type === "video"
				? document.createElement("video")
				: document.createElement("div");
	el.className = "notgt-layer";
	el.dataset["layerId"] = layer.id;
	applyLayerStyle(el, layer);
	if (el instanceof HTMLVideoElement) applyVideoAttributes(el, layer);
	return el;
}

function rotate(style: LayerStyle): string {
	return style.rotation ? `rotate(${style.rotation}deg)` : "";
}

export function applyLayerStyle(el: HTMLElement, layer: Layer): void {
	const s: LayerStyle = layer.style ?? {};
	const st = el.style;

	st.left = `${layer.x}%`;
	st.top = `${layer.y}%`;
	st.width = layer.width !== undefined ? `${layer.width}%` : "";
	st.height = layer.height !== undefined ? `${layer.height}%` : "";
	st.opacity = String(s.opacity ?? 1);
	st.zIndex = String(layer.z ?? 0);
	st.transform = rotate(s);
	st.display = layer.hidden ? "none" : "";
	st.pointerEvents = "none";

	if (layer.type === "text") {
		st.fontFamily = s.fontFamily ?? "Inter, Arial, sans-serif";
		st.fontSize = `${s.fontSize ?? 48}px`;
		st.fontWeight = String(s.fontWeight ?? 400);
		st.fontStyle = s.fontStyle ?? "normal";
		st.color = s.color ?? "#ffffff";
		st.textAlign = s.align ?? "left";
		st.lineHeight = String(s.lineHeight ?? 1.2);
		st.letterSpacing = s.letterSpacing !== undefined ? `${s.letterSpacing}px` : "";
		st.textTransform = s.textTransform ?? "none";
		st.padding = s.padding !== undefined ? `${s.padding}px` : "0";
		st.whiteSpace = "pre-wrap";
		st.overflow = "visible";

		if (layer.height !== undefined) {
			st.display = layer.hidden ? "none" : "flex";
			st.flexDirection = "column";
			st.justifyContent =
				s.verticalAlign === "middle"
					? "center"
					: s.verticalAlign === "bottom"
						? "flex-end"
						: "flex-start";
		}
		if (s.textStrokeWidth) {
			(st as unknown as Record<string, string>)["webkitTextStroke"] =
				`${s.textStrokeWidth}px ${s.textStrokeColor ?? "#000000"}`;
		}
		if (s.shadowColor) {
			st.textShadow = `${s.shadowOffsetX ?? 0}px ${s.shadowOffsetY ?? 0}px ${s.shadowBlur ?? 0}px ${s.shadowColor}`;
		}
		if (s.fill) st.background = s.fill;
		if (s.radius) st.borderRadius = `${s.radius}px`;
		if (s.stroke && s.strokeWidth) st.border = `${s.strokeWidth}px solid ${s.stroke}`;
		return;
	}

	if (layer.type === "shape") {
		st.background = s.fill ?? "rgba(255,255,255,0.9)";
		st.borderRadius =
			layer.shape === "ellipse" ? "50%" : s.radius !== undefined ? `${s.radius}px` : "0";
		if (s.stroke && s.strokeWidth) st.border = `${s.strokeWidth}px solid ${s.stroke}`;
		if (s.shadowColor) {
			st.boxShadow = `${s.shadowOffsetX ?? 0}px ${s.shadowOffsetY ?? 0}px ${s.shadowBlur ?? 0}px ${s.shadowColor}`;
		}
		return;
	}

	// image / gif / video
	st.objectFit = "contain";
	st.display = layer.hidden ? "none" : "block";
	if (s.radius) st.borderRadius = `${s.radius}px`;
	if (layer.type === "video") st.backgroundColor = "transparent";
}

/**
 * Applies the media attributes of a video layer.
 *
 * `muted` is on by default because Chromium only autoplays muted media; an
 * overlay should not carry audio anyway (use a dedicated source for that).
 */
function applyVideoAttributes(el: HTMLVideoElement, layer: Layer): void {
	const s: LayerStyle = layer.style ?? {};
	el.muted = s.videoMuted ?? true;
	el.defaultMuted = el.muted;
	el.loop = s.videoLoop ?? true;
	el.autoplay = s.videoAutoplay ?? true;
	el.playsInline = true;
	el.preload = "auto";
	el.controls = false;
	el.disablePictureInPicture = true;
	if (s.videoRate) el.playbackRate = s.videoRate;
}

/**
 * Rewinds and plays every video layer of a slot. Called whenever the slot's
 * entrance animation (re)starts, so a trigger restarts the clip from frame 0.
 */
export function restartVideoLayers(layerEls: Map<string, HTMLElement>): void {
	for (const el of layerEls.values()) {
		if (!(el instanceof HTMLVideoElement)) continue;
		try {
			el.currentTime = 0;
		} catch {
			// Not seekable yet (metadata still loading) — it will start at 0 anyway.
		}
		void el.play?.().catch(() => {});
	}
}

/** Pauses every video layer, e.g. while a slot plays its exit transition. */
export function pauseVideoLayers(layerEls: Map<string, HTMLElement>): void {
	for (const el of layerEls.values()) {
		if (el instanceof HTMLVideoElement) el.pause();
	}
}

/** Updates only what actually changed — this is what keeps text flicker-free. */
export function updateLayerContent(
	el: HTMLElement,
	layer: Layer,
	data: TitleData,
	selection: VariableSelection = {},
): void {
	if (layer.type === "text") {
		const next = resolveLayerText(layer, data, selection);
		if (el.textContent !== next) el.textContent = next;
		return;
	}
	if (layer.type === "image" || layer.type === "gif") {
		const next = layer.src ? interpolate(layer.src, data, selection) : "";
		const img = el as HTMLImageElement;
		const current = img.getAttribute("src") ?? "";
		if (next && current !== next) img.setAttribute("src", next);
		else if (!next && current) img.removeAttribute("src");
		return;
	}
	if (layer.type === "video") {
		const video = el as HTMLVideoElement;
		const next = layer.src ? interpolate(layer.src, data, selection) : "";
		const current = video.getAttribute("src") ?? "";
		if (next && current !== next) {
			video.setAttribute("src", next);
			video.load();
		} else if (!next && current) {
			video.removeAttribute("src");
			video.load();
		}
		if (next && video.style.display !== "none") {
			void video.play?.().catch(() => {});
		}
	}
}
