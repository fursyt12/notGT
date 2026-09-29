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
	const full = fullCrop(template);
	const crop = item.crop;
	if (!crop) return full;
	const x = clamp(crop.x, 0, full.width - MIN_CROP_PX);
	const y = clamp(crop.y, 0, full.height - MIN_CROP_PX);
	return {
		x,
		y,
		width: clamp(crop.width, MIN_CROP_PX, full.width - x),
		height: clamp(crop.height, MIN_CROP_PX, full.height - y),
	};
}

/** Rounded to 0.01 design px — the precision the editor writes. */
export function roundCrop(crop: ItemCrop): ItemCrop {
	const at = (value: number) => Math.round(value * 100) / 100;
	return { x: at(crop.x), y: at(crop.y), width: at(crop.width), height: at(crop.height) };
}

/** True when the window covers the whole box, i.e. there is nothing to clip. */
export function cropIsFull(crop: ItemCrop, template: TitleTemplate): boolean {
	const full = fullCrop(template);
	return (
		crop.x <= 0 &&
		crop.y <= 0 &&
		crop.width >= full.width - 0.01 &&
		crop.height >= full.height - 0.01
	);
}
