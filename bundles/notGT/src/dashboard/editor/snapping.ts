/**
 * Magnetic snapping for the editor canvas.
 *
 * The editor works in *stage* pixels: the out's design box scaled by `fit`, so
 * `stageW` stage px are exactly `stageW` CSS px on the canvas. Every coordinate
 * in this module is therefore a plain pixel coordinate of the box being dragged;
 * callers convert to and from the stored percentages themselves.
 *
 * The model is deliberately symmetric: a dragged box offers three coordinates
 * per axis — its start, its centre and its end — and each of them may stick to
 * any target line. The smallest move that brings a pair together wins, and the
 * centre is tried first so that "centre to centre" beats "edge to edge" when
 * both are equally close.
 */

export interface SnapBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A line a start / centre / end of the dragged box can stick to. */
export interface SnapLine {
	/** Position on the axis, in stage px. */
	at: number;
	/** Shown next to the guide, e.g. «центр out'а». Purely informational. */
	label?: string;
}

export interface SnapOutcome {
	/** The box after snapping (unchanged when nothing matched). */
	box: SnapBox;
	/** Matched vertical lines (x) and horizontal lines (y), for the guides. */
	guidesX: number[];
	guidesY: number[];
}

interface Match {
	delta: number;
	at: number;
}

/**
 * Closest line within `threshold`, or `null`.
 *
 * `coords` is ordered by preference (centre first), but the smallest distance
 * always wins regardless of that order; the order only breaks ties.
 */
function closest(coords: number[], lines: SnapLine[], threshold: number): Match | null {
	let best: Match | null = null;
	for (const coord of coords) {
		for (const line of lines) {
			const delta = line.at - coord;
			if (Math.abs(delta) > threshold) continue;
			if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
				best = { delta, at: line.at };
			}
		}
	}
	return best;
}

/**
 * Snaps `box` to the nearest lines on each axis, independently: a box may stick
 * horizontally to one guide and vertically to another.
 */
export function snapBox(
	box: SnapBox,
	linesX: SnapLine[],
	linesY: SnapLine[],
	threshold: number,
): SnapOutcome {
	if (threshold <= 0) return { box, guidesX: [], guidesY: [] };

	const dx = closest([box.x + box.width / 2, box.x, box.x + box.width], linesX, threshold);
	const dy = closest([box.y + box.height / 2, box.y, box.y + box.height], linesY, threshold);

	return {
		box: { ...box, x: box.x + (dx?.delta ?? 0), y: box.y + (dy?.delta ?? 0) },
		guidesX: dx ? [dx.at] : [],
		guidesY: dy ? [dy.at] : [],
	};
}

/**
 * Snaps a single coordinate — one edge of a box being resized — to the nearest
 * line. `snapBox` is for moving a whole box; resizing has to leave the opposite
 * edge exactly where the operator put it, and that edge is usually *on* a line
 * already, which would win every comparison.
 */
export function snapCoordinate(
	value: number,
	lines: SnapLine[],
	threshold: number,
): { value: number; guide: number[] } {
	if (threshold <= 0) return { value, guide: [] };
	const match = closest([value], lines, threshold);
	if (!match) return { value, guide: [] };
	return { value: value + match.delta, guide: [match.at] };
}

/**
 * Snaps the scale of a box that is resized from its top-left corner with its
 * proportions kept — a placement under the size handle.
 *
 * Such a resize has one degree of freedom, so a line on either axis decides
 * the scale for both: the box's far edge or its centre lands on the line, and
 * the other axis follows. The line that is closest on screen wins, the centre
 * first on a tie, the same as when a box is moved.
 */
export function snapScale(
	scale: number,
	/** The corner that stays put, in stage px. */
	origin: { x: number; y: number },
	/** Size of the box at scale 1, in stage px. */
	unit: { width: number; height: number },
	linesX: SnapLine[],
	linesY: SnapLine[],
	threshold: number,
): { scale: number; guidesX: number[]; guidesY: number[] } {
	const none = { scale, guidesX: [], guidesY: [] };
	if (threshold <= 0 || unit.width <= 0 || unit.height <= 0) return none;

	const found: Array<{ scale: number; distance: number }> = [];
	const consider = (lines: SnapLine[], start: number, size: number, part: number) => {
		for (const line of lines) {
			const distance = Math.abs(line.at - (start + size * scale * part));
			if (distance > threshold) continue;
			const candidate = (line.at - start) / (size * part);
			if (candidate > 0) found.push({ scale: candidate, distance });
		}
	};
	// `part` is how far along the box the point sits: 0.5 its centre, 1 its far edge.
	consider(linesX, origin.x, unit.width, 0.5);
	consider(linesY, origin.y, unit.height, 0.5);
	consider(linesX, origin.x, unit.width, 1);
	consider(linesY, origin.y, unit.height, 1);
	if (found.length === 0) return none;

	const snapped = found.reduce((best, next) => (next.distance < best.distance ? next : best)).scale;
	// Every line the snapped box now sits on gets a guide, whichever axis decided.
	const touched = (lines: SnapLine[], start: number, size: number) => [
		...new Set(
			lines
				.map((line) => line.at)
				.filter((at) => [0.5, 1].some((part) => Math.abs(start + size * snapped * part - at) < 0.5)),
		),
	];
	return {
		scale: snapped,
		guidesX: touched(linesX, origin.x, unit.width),
		guidesY: touched(linesY, origin.y, unit.height),
	};
}

/**
 * Lines every placement can stick to: the out's edges, its centre, the 5 %
 * broadcast safe area, and the edges and centres of the *other* animations on
 * the same out (so two titles can be lined up against each other).
 */
export function placementSnapLines(
	stageW: number,
	stageH: number,
	others: Array<{ boxX: number; boxY: number; boxW: number; boxH: number }>,
): { x: SnapLine[]; y: SnapLine[] } {
	const x: SnapLine[] = [
		{ at: 0, label: "левый край" },
		{ at: stageW * 0.05, label: "безопасная зона" },
		{ at: stageW / 2, label: "центр по горизонтали" },
		{ at: stageW * 0.95, label: "безопасная зона" },
		{ at: stageW, label: "правый край" },
	];
	const y: SnapLine[] = [
		{ at: 0, label: "верхний край" },
		{ at: stageH * 0.05, label: "безопасная зона" },
		{ at: stageH / 2, label: "центр по вертикали" },
		{ at: stageH * 0.95, label: "безопасная зона" },
		{ at: stageH, label: "нижний край" },
	];
	for (const other of others) {
		x.push(
			{ at: other.boxX, label: "другая анимация" },
			{ at: other.boxX + other.boxW / 2, label: "центр другой анимации" },
			{ at: other.boxX + other.boxW, label: "другая анимация" },
		);
		y.push(
			{ at: other.boxY, label: "другая анимация" },
			{ at: other.boxY + other.boxH / 2, label: "центр другой анимации" },
			{ at: other.boxY + other.boxH, label: "другая анимация" },
		);
	}
	return { x, y };
}

/**
 * The edges and the centre of one box, in that box's own pixel space. Used for
 * layers (inside a template) and for a crop window (inside the same box).
 */
export function boxSnapLines(width: number, height: number): { x: SnapLine[]; y: SnapLine[] } {
	return {
		x: [
			{ at: 0, label: "край шаблона" },
			{ at: width / 2, label: "центр шаблона" },
			{ at: width, label: "край шаблона" },
		],
		y: [
			{ at: 0, label: "край шаблона" },
			{ at: height / 2, label: "центр шаблона" },
			{ at: height, label: "край шаблона" },
		],
	};
}

/**
 * Lines a layer can stick to, in the *template's* pixel space (the parent group
 * the layers live in): the edges and centre of the animation box itself, plus
 * the edges and centres of the other layers that have an explicit box.
 *
 * Layers without `width`/`height` (auto-sized text, images) have no known box
 * and are skipped as targets.
 */
export function layerSnapLines(
	templateWidth: number,
	templateHeight: number,
	k: number,
	layers: Array<{
		id: string;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		hidden?: boolean;
	}>,
	skipId: string | null,
): { x: SnapLine[]; y: SnapLine[] } {
	const boxW = templateWidth * k;
	const boxH = templateHeight * k;
	const { x, y } = boxSnapLines(boxW, boxH);
	for (const layer of layers) {
		if (layer.id === skipId || layer.hidden) continue;
		if (layer.width === undefined || layer.height === undefined) continue;
		const left = ((layer.x ?? 0) / 100) * boxW;
		const top = ((layer.y ?? 0) / 100) * boxH;
		const width = (layer.width / 100) * boxW;
		const height = (layer.height / 100) * boxH;
		x.push(
			{ at: left, label: "другой слой" },
			{ at: left + width / 2, label: "центр другого слоя" },
			{ at: left + width, label: "другой слой" },
		);
		y.push(
			{ at: top, label: "другой слой" },
			{ at: top + height / 2, label: "центр другого слоя" },
			{ at: top + height, label: "другой слой" },
		);
	}
	return { x, y };
}
