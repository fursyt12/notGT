/**
 * Corner pin: the four corners of a placement's visible window, each moved on
 * its own.
 *
 * A crop cuts and a stretch resizes; a corner pin warps. The picture is mapped
 * from its rectangle onto any convex four-sided shape — the perspective
 * projection that fits a title onto a screen or a wall seen at an angle. The
 * corners are kept in the template's design px, relative to the top-left of its
 * box, so moving, scaling or stretching the placement carries the warp along.
 *
 * The out page applies the warp as a CSS `matrix3d` on the placement and the
 * editor canvas draws the pinned placement with the very same transform, so
 * what the editor shows is what OBS gets.
 */
import type { ItemCorners, ItemCrop, OutItem } from "./types";

export type CornerKey = keyof ItemCorners;

/** Clockwise from the top-left, the order every polygon here is drawn in. */
export const CORNER_KEYS: readonly CornerKey[] = ["tl", "tr", "br", "bl"];

/** The corners of a rectangle — what "no corner pin" means for that window. */
export function rectCorners(rect: ItemCrop): ItemCorners {
	return {
		tl: { x: rect.x, y: rect.y },
		tr: { x: rect.x + rect.width, y: rect.y },
		br: { x: rect.x + rect.width, y: rect.y + rect.height },
		bl: { x: rect.x, y: rect.y + rect.height },
	};
}

/** The placement's corner pin, or `null` without one (or with a broken one). */
export function cornersOf(item: Pick<OutItem, "corners">): ItemCorners | null {
	const corners = item.corners;
	if (!corners) return null;
	for (const key of CORNER_KEYS) {
		const point = corners[key];
		if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
	}
	return isConvex(corners) ? corners : null;
}

/**
 * A shape a picture can be warped onto: every turn goes the same way. A corner
 * dragged across the opposite edge would fold the picture over itself, which no
 * projection can draw.
 */
export function isConvex(corners: ItemCorners): boolean {
	const points = CORNER_KEYS.map((key) => corners[key]);
	let sign = 0;
	for (let index = 0; index < 4; index++) {
		const a = points[index]!;
		const b = points[(index + 1) % 4]!;
		const c = points[(index + 2) % 4]!;
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (Math.abs(cross) < 1e-6) return false;
		const turn = Math.sign(cross);
		if (sign === 0) sign = turn;
		else if (turn !== sign) return false;
	}
	return true;
}

/** The rectangle around the pinned shape, in design px. */
export function cornersBounds(corners: ItemCorners): ItemCrop {
	const xs = CORNER_KEYS.map((key) => corners[key].x);
	const ys = CORNER_KEYS.map((key) => corners[key].y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * What to write to a placement: the corners rounded to 0.01 design px, or
 * `undefined` when they are back on the window's own corners.
 */
export function cornersPatch(corners: ItemCorners, rect: ItemCrop): ItemCorners | undefined {
	const at = (value: number) => Math.round(value * 100) / 100;
	const plain = rectCorners(rect);
	let moved = false;
	const next = {} as ItemCorners;
	for (const key of CORNER_KEYS) {
		next[key] = { x: at(corners[key].x), y: at(corners[key].y) };
		if (Math.abs(next[key].x - plain[key].x) > 0.01 || Math.abs(next[key].y - plain[key].y) > 0.01) {
			moved = true;
		}
	}
	return moved ? next : undefined;
}

/**
 * The CSS transform that warps an element showing `rect` onto `corners`.
 *
 * The element's own px start at the rectangle's top-left (that is how the out
 * page places a cropped window, and without a crop the rectangle is the whole
 * box at 0,0), and so does the result: the corners are taken relative to the
 * same point. `transform-origin` has to be the top-left corner.
 *
 * The projection is the classic square-to-quad mapping (Heckbert), scaled from
 * the rectangle's size down to the unit square first.
 */
export function cornerPinCss(rect: ItemCrop, corners: ItemCorners): string {
	const p0 = { x: corners.tl.x - rect.x, y: corners.tl.y - rect.y };
	const p1 = { x: corners.tr.x - rect.x, y: corners.tr.y - rect.y };
	const p2 = { x: corners.br.x - rect.x, y: corners.br.y - rect.y };
	const p3 = { x: corners.bl.x - rect.x, y: corners.bl.y - rect.y };

	const sx = p0.x - p1.x + p2.x - p3.x;
	const sy = p0.y - p1.y + p2.y - p3.y;
	let a: number, b: number, d: number, e: number, g: number, h: number;
	if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
		// A parallelogram: no perspective, only a slant.
		a = p1.x - p0.x;
		b = p3.x - p0.x;
		d = p1.y - p0.y;
		e = p3.y - p0.y;
		g = 0;
		h = 0;
	} else {
		const dx1 = p1.x - p2.x;
		const dx2 = p3.x - p2.x;
		const dy1 = p1.y - p2.y;
		const dy2 = p3.y - p2.y;
		const det = dx1 * dy2 - dx2 * dy1;
		g = (sx * dy2 - dx2 * sy) / det;
		h = (dx1 * sy - sx * dy1) / det;
		a = p1.x - p0.x + g * p1.x;
		b = p3.x - p0.x + h * p3.x;
		d = p1.y - p0.y + g * p1.y;
		e = p3.y - p0.y + h * p3.y;
	}

	// The element's px -> the unit square.
	const w = rect.width > 0 ? rect.width : 1;
	const hh = rect.height > 0 ? rect.height : 1;
	const n = (value: number) => (Number.isFinite(value) ? Number(value.toPrecision(10)) : 0);
	// matrix3d is column-major: x' = a·u + b·v + c, y' = d·u + e·v + f, w = g·u + h·v + 1.
	return `matrix3d(${[
		a / w, d / w, 0, g / w,
		b / hh, e / hh, 0, h / hh,
		0, 0, 1, 0,
		p0.x, p0.y, 0, 1,
	]
		.map(n)
		.join(", ")})`;
}
