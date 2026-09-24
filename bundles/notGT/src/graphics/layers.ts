import { getByPath, interpolate } from "../shared/binding";
import type { Layer, LayerStyle, TitleData } from "../shared/types";

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
export function resolveLayerText(layer: Layer, data: TitleData): string {
	if (layer.binding) {
		const direct = stringifyValue(getByPath(data, layer.binding));
		if (direct !== "") return direct;
	}
	return interpolate(layer.text ?? "", data);
}

export function createLayerElement(layer: Layer): HTMLElement {
	const el =
		layer.type === "image" || layer.type === "gif"
			? document.createElement("img")
			: document.createElement("div");
	el.className = "notgt-layer";
	el.dataset["layerId"] = layer.id;
	applyLayerStyle(el, layer);
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

	// image / gif
	st.objectFit = "contain";
	st.display = layer.hidden ? "none" : "block";
	if (s.radius) st.borderRadius = `${s.radius}px`;
}

/** Updates only what actually changed — this is what keeps text flicker-free. */
export function updateLayerContent(
	el: HTMLElement,
	layer: Layer,
	data: TitleData,
): void {
	if (layer.type === "text") {
		const next = resolveLayerText(layer, data);
		if (el.textContent !== next) el.textContent = next;
		return;
	}
	if (layer.type === "image" || layer.type === "gif") {
		const next = layer.src ? interpolate(layer.src, data) : "";
		const img = el as HTMLImageElement;
		const current = img.getAttribute("src") ?? "";
		if (next && current !== next) img.setAttribute("src", next);
		else if (!next && current) img.removeAttribute("src");
	}
}
