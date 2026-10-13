/**
 * Timing of entrances and exits, shared by the out page, which plays them, and
 * the editor, which draws them.
 *
 * A `layers` animation has one transition for the whole picture and, on top of
 * it, an optional one per layer. Each waits its own `delayMs` and then runs for
 * `durationMs`. All the clocks of a phase start together: when the animation
 * is shown for an entrance, when it is taken off for an exit.
 */
import type { Layer, TitleTemplate, Transition } from "./types";

export type MotionPhase = "in" | "out";

/** Upper bound on a single delay or duration, ms. */
export const MOTION_MAX_MS = 60_000;

export interface MotionSpan {
	delay: number;
	duration: number;
	/** `delay + duration`: when the transition is over. */
	end: number;
}

function ms(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(MOTION_MAX_MS, Math.max(0, Math.round(value)))
		: 0;
}

/** When a transition starts and how long it runs. `none` is a cut: it takes no time. */
export function transitionSpan(transition: Transition | undefined): MotionSpan {
	if (!transition) return { delay: 0, duration: 0, end: 0 };
	const delay = ms(transition.delayMs);
	const duration = transition.type === "none" ? 0 : ms(transition.durationMs);
	return { delay, duration, end: delay + duration };
}

export function templateTransition(
	template: TitleTemplate,
	phase: MotionPhase,
): Transition | undefined {
	return phase === "in" ? template.inTransition : template.outTransition;
}

/** A layer's own transition for a phase, when it has one. */
export function layerTransition(layer: Layer, phase: MotionPhase): Transition | undefined {
	return phase === "in" ? layer.inTransition : layer.outTransition;
}

/**
 * How long a whole phase takes: until the last transition in it is over. A
 * hidden layer is not drawn, so it does not count; a code animation times
 * itself.
 */
export function phaseMs(template: TitleTemplate, phase: MotionPhase): number {
	if (template.kind === "code") return 0;
	let end = transitionSpan(templateTransition(template, phase)).end;
	for (const layer of template.layers ?? []) {
		if (layer.hidden) continue;
		end = Math.max(end, transitionSpan(layerTransition(layer, phase)).end);
	}
	return end;
}

/**
 * When the whole animation's own exit has taken the picture away, ms into the
 * exit — whatever a layer still does after that is not seen. `null` when the
 * exit of the whole animation hides nothing: no transition and no delay.
 */
export function goneAfterMs(template: TitleTemplate): number | null {
	const transition = template.outTransition;
	const span = transitionSpan(transition);
	if (!transition || (transition.type === "none" && span.delay === 0)) return null;
	return span.end;
}
