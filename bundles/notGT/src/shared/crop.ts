/**
 * Crop windows on a placement.
 *
 * A crop hides everything outside a rectangle of the template's design box
 * without touching the box itself: the placement stays where it was and keeps
 * its scale, so cropping a title only removes what the operator does not want
 * on screen. The dashboard canvas and the out page both derive the visible
 * window from here, so what the editor draws is what OBS shows.
 *
 * The rectangle is stored in template design pixels and is always normalized
 * against the template's current size: a crop older than the template, or one
 * dragged a pixel past an edge, still yields a sane box.
 *
 * Scaled bounds are the other kind of window: the animation's box itself made
 * bigger or smaller (the Scale Bounds tool). They are the same rectangle in the
 * same px, but free to reach past the design box, so a box grown to the right
 * shows what the animation draws there. Both end up as the one window the out
 * page and the canvas clip at (`windowBox`).
 */
import type { ItemCrop, OutItem, TitleTemplate } from "./types";

/** Never let a crop collapse into nothing (design px). */
export const MIN_CROP_PX = 4;

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** The whole template box as a crop — what "no crop" means. */
export function fullCrop(template: TitleTemplate): ItemCrop {
	return { x: 0, y: 0, width: Math.max(1, template.width), height: Math.max(1, template.height) };
}

/** Does this placement hide anything? */
export function hasCrop(item: OutItem): boolean {
	return item.crop !== undefined;
}

/**
 * The visible window of a placement: its crop, clamped into the template box,
 * or the whole box when it has none.
 */
export function cropBox(item: OutItem, template: TitleTemplate): ItemCrop {
	return item.crop ? clampCrop(item.crop, template) : fullCrop(template);
}

/** A window clamped into the template box, the way a crop is kept. */
export function clampCrop(crop: ItemCrop, template: TitleTemplate): ItemCrop {
	const full = fullCrop(template);
	const x = clamp(crop.x, 0, full.width - MIN_CROP_PX);
	const y = clamp(crop.y, 0, full.height - MIN_CROP_PX);
	return {
		x,
		y,
		width: clamp(crop.width, MIN_CROP_PX, full.width - x),
		height: clamp(crop.height, MIN_CROP_PX, full.height - y),
	};
}

/**
 * The window a placement is drawn in: its scaled bounds when it has them, else
 * its crop, else the whole box. Bounds only keep a minimum size; where they sit
 * is up to the operator.
 */
export function windowBox(item: OutItem, template: TitleTemplate): ItemCrop {
	const bounds = item.bounds;
	if (!bounds) return cropBox(item, template);
	const at = (value: number) => (Number.isFinite(value) ? value : 0);
	return {
		x: at(bounds.x),
		y: at(bounds.y),
		width: clamp(bounds.width, MIN_CROP_PX, Number.MAX_SAFE_INTEGER),
		height: clamp(bounds.height, MIN_CROP_PX, Number.MAX_SAFE_INTEGER),
	};
}

/** Rounded to 0.01 design px — the precision the editor writes. */
export function roundCrop(crop: ItemCrop): ItemCrop {
	const at = (value: number) => Math.round(value * 100) / 100;
	return { x: at(crop.x), y: at(crop.y), width: at(crop.width), height: at(crop.height) };
}

/**
 * True when the window is the whole box, i.e. there is nothing to clip. A window
 * bigger than the box is not: it clips too, only further out.
 */
export function cropIsFull(crop: ItemCrop, template: TitleTemplate): boolean {
	const full = fullCrop(template);
	return (
		Math.abs(crop.x) < 0.01 &&
		Math.abs(crop.y) < 0.01 &&
		Math.abs(crop.width - full.width) < 0.01 &&
		Math.abs(crop.height - full.height) < 0.01
	);
}
