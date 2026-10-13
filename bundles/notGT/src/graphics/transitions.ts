import { transitionSpan } from "../shared/motion";
import type { Layer, Transition, TransitionType } from "../shared/types";

const SLIDE_X = 150;
const SLIDE_Y = 96;

const ENTER_EASING = "cubic-bezier(.2,.8,.2,1)";
const EXIT_EASING = "ease-in";

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
			// A cut. It is only asked for when it has a delay to wait out, and
			// until then the picture is simply not there.
			return { ...NEUTRAL, opacity: "0" };
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

function props(durationMs: number, easing: string, delayMs: number): string {
	return [
		`opacity ${durationMs}ms ${easing} ${delayMs}ms`,
		`transform ${durationMs}ms ${easing} ${delayMs}ms`,
		`clip-path ${durationMs}ms ${easing} ${delayMs}ms`,
	].join(", ");
}

/** Plays the entrance transition on `el` (the animator wrapper). */
export function enterAnimation(el: HTMLElement, transition?: Transition): void {
	const { delay, duration, end } = transitionSpan(transition);
	el.style.transition = "none";
	if (end === 0) {
		apply(el, NEUTRAL);
		return;
	}
	apply(el, awayState(transition?.type ?? "fade"));
	// Force a style flush so the browser registers the starting frame.
	void el.offsetWidth;
	el.style.transition = props(duration, transition?.easing || ENTER_EASING, delay);
	apply(el, NEUTRAL);
}

/**
 * Starts the exit transition on `el`. It is over `transitionSpan(transition).end`
 * ms later; the caller removes the slot then (see `phaseMs`).
 */
export function exitAnimation(el: HTMLElement, transition: Transition | undefined): void {
	const { delay, duration, end } = transitionSpan(transition);
	if (end === 0) return;
	el.style.transition = props(duration, transition?.easing || EXIT_EASING, delay);
	apply(el, NEUTRAL);
	void el.offsetWidth;
	apply(el, awayState(transition?.type ?? "fade"));
}

// ---------------------------------------------------------------------------
// A layer's own entrance and exit
//
// These run on the layer element, inside the wrapper and at the same time as
// its transition. A layer already has an opacity and a rotation of its own in
// its inline style, so instead of rewriting that style the transition is a Web
// Animation laid over it: when the entrance is over the animation lets go and
// the layer is exactly as it was styled.
// ---------------------------------------------------------------------------

/**
 * The two ends of a layer's transition: `away` is the layer before its entrance
 * and after its exit, `home` is the layer as it is styled. Only the properties
 * the transition moves are listed, so the rest of the style is left alone.
 */
function layerFrames(type: TransitionType, layer: Layer): { away: Keyframe; home: Keyframe } {
	const opacity = layer.style?.opacity ?? 1;
	// Every transform has to carry the layer's own rotation along.
	const rotate = layer.style?.rotation ? ` rotate(${layer.style.rotation}deg)` : "";
	const slide = (x: number, y: number) => ({
		away: { opacity: 0, transform: `translate3d(${x}px,${y}px,0)${rotate}` },
		home: { opacity, transform: `translate3d(0,0,0)${rotate}` },
	});
	switch (type) {
		case "slide-left":
			return slide(-SLIDE_X, 0);
		case "slide-right":
			return slide(SLIDE_X, 0);
		case "slide-up":
			return slide(0, SLIDE_Y);
		case "slide-down":
			return slide(0, -SLIDE_Y);
		case "scale":
			return {
				away: { opacity: 0, transform: `scale(0.94)${rotate}` },
				home: { opacity, transform: `scale(1)${rotate}` },
			};
		case "wipe-left":
			return { away: { clipPath: "inset(0 0 0 100%)" }, home: { clipPath: "inset(0 0 0 0)" } };
		case "wipe-right":
			return { away: { clipPath: "inset(0 100% 0 0)" }, home: { clipPath: "inset(0 0 0 0)" } };
		default:
			// `fade`, and `none` too: a cut is a fade that takes no time.
			return { away: { opacity: 0 }, home: { opacity } };
	}
}

function play(
	el: HTMLElement,
	frames: Keyframe[],
	timing: KeyframeAnimationOptions,
	fallbackEasing: string,
): void {
	try {
		el.animate(frames, timing);
	} catch {
		// An easing the browser cannot read: the transition still plays.
		el.animate(frames, { ...timing, easing: fallbackEasing });
	}
}

/**
 * Stops whatever a layer is playing. With `keep` the layer stays where it had
 * got to instead of snapping back to its own style. Returns whether anything
 * was running.
 */
function stopLayer(el: HTMLElement, keep: boolean): boolean {
	const running = typeof el.getAnimations === "function" ? el.getAnimations() : [];
	for (const animation of running) {
		if (keep) {
			try {
				animation.commitStyles();
			} catch {
				// Not rendered: there is nothing to keep.
			}
		}
		animation.cancel();
	}
	return running.length > 0;
}

/**
 * Plays a layer's own entrance, from the start: a layer that is already on
 * screen (a re-trigger) plays it again. Until its delay is over the layer is
 * kept away, so a delayed layer does not flash before it comes in.
 */
export function enterLayer(el: HTMLElement, layer: Layer): void {
	stopLayer(el, false);
	const transition = layer.inTransition;
	if (!transition || layer.hidden || typeof el.animate !== "function") return;
	const { delay, duration, end } = transitionSpan(transition);
	if (end === 0) return;
	const { away, home } = layerFrames(transition.type, layer);
	play(
		el,
		[away, home],
		{ delay, duration, easing: transition.easing || ENTER_EASING, fill: "backwards" },
		ENTER_EASING,
	);
}

/**
 * Plays a layer's own exit and leaves the layer away when it is over. The slot
 * is dropped by the out page once the whole exit has run (see `phaseMs`).
 */
export function exitLayer(el: HTMLElement, layer: Layer): void {
	// An exit that cuts an entrance short goes on from where the layer got to.
	const interrupted = stopLayer(el, true);
	const transition = layer.outTransition;
	if (!transition || layer.hidden || typeof el.animate !== "function") return;
	const { delay, duration } = transitionSpan(transition);
	const { away, home } = layerFrames(transition.type, layer);
	let from: Keyframe | null = home;
	if (interrupted) {
		// A wipe cannot start from "no clip at all", so that one end is spelled
		// out; everything else starts from what the layer looks like right now.
		from =
			"clipPath" in away && getComputedStyle(el).clipPath === "none"
				? { clipPath: home["clipPath"] }
				: null;
	}
	play(
		el,
		from ? [from, away] : [away],
		{ delay, duration, easing: transition.easing || EXIT_EASING, fill: "forwards" },
		EXIT_EASING,
	);
}
