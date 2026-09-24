import type { Transition, TransitionType } from "../shared/types";

const SLIDE_X = 150;
const SLIDE_Y = 96;

interface VisualState {
	opacity?: string;
	transform?: string;
	clipPath?: string;
}

const NEUTRAL: VisualState = {
	opacity: "1",
	transform: "translate3d(0,0,0) scale(1)",
	clipPath: "inset(0 0 0 0)",
};

/** The "off screen" state a transition starts from (enter) or ends at (exit). */
function awayState(type: TransitionType): VisualState {
	switch (type) {
		case "none":
			return { ...NEUTRAL };
		case "fade":
			return { ...NEUTRAL, opacity: "0" };
		case "slide-left":
			return { ...NEUTRAL, opacity: "0", transform: `translate3d(${-SLIDE_X}px,0,0)` };
		case "slide-right":
			return { ...NEUTRAL, opacity: "0", transform: `translate3d(${SLIDE_X}px,0,0)` };
		case "slide-up":
			return { ...NEUTRAL, opacity: "0", transform: `translate3d(0,${SLIDE_Y}px,0)` };
		case "slide-down":
			return { ...NEUTRAL, opacity: "0", transform: `translate3d(0,${-SLIDE_Y}px,0)` };
		case "scale":
			return { ...NEUTRAL, opacity: "0", transform: "scale(0.94)" };
		case "wipe-left":
			return { ...NEUTRAL, clipPath: "inset(0 0 0 100%)" };
		case "wipe-right":
			return { ...NEUTRAL, clipPath: "inset(0 100% 0 0)" };
		default:
			return { ...NEUTRAL, opacity: "0" };
	}
}

function apply(el: HTMLElement, state: VisualState): void {
	el.style.opacity = state.opacity ?? "1";
	el.style.transform = state.transform ?? "translate3d(0,0,0) scale(1)";
	el.style.clipPath = state.clipPath ?? "inset(0 0 0 0)";
}

function props(durationMs: number, easing: string): string {
	return [
		`opacity ${durationMs}ms ${easing}`,
		`transform ${durationMs}ms ${easing}`,
		`clip-path ${durationMs}ms ${easing}`,
	].join(", ");
}

/** Plays the entrance transition on `el` (usually the animator wrapper). */
export function enterAnimation(el: HTMLElement, transition?: Transition): void {
	const duration = Math.max(0, transition?.durationMs ?? 0);
	const easing = transition?.easing || "cubic-bezier(.2,.8,.2,1)";
	if (duration === 0) {
		el.style.transition = "none";
		apply(el, NEUTRAL);
		return;
	}
	el.style.transition = "none";
	apply(el, awayState(transition?.type ?? "fade"));
	// Force a style flush so the browser registers the starting frame.
	void el.offsetWidth;
	el.style.transition = props(duration, easing);
	apply(el, NEUTRAL);
}

/** Plays the exit transition, then calls `done`. */
export function exitAnimation(
	el: HTMLElement,
	transition: Transition | undefined,
	done: () => void,
): void {
	const duration = Math.max(0, transition?.durationMs ?? 0);
	const easing = transition?.easing || "ease-in";
	if (duration === 0) {
		done();
		return;
	}
	el.style.transition = props(duration, easing);
	apply(el, NEUTRAL);
	void el.offsetWidth;
	apply(el, awayState(transition?.type ?? "fade"));
	window.setTimeout(done, duration + 40);
}
