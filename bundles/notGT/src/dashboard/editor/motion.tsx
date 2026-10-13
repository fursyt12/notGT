/**
 * notGT editor — entrances and exits.
 *
 * A `layers` animation comes in and goes out as a whole (the template's
 * `inTransition` / `outTransition`), and any layer may add a transition of its
 * own on top of that, with its own delay. This module has the fields of one
 * transition and the timeline that shows all of them at once: the whole
 * animation and every layer, the entrance on the left and the exit on the
 * right, each bar starting at its delay and as long as its duration.
 */
import {
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";

import {
	MOTION_MAX_MS,
	goneAfterMs,
	phaseMs,
	transitionSpan,
	type MotionPhase,
	type MotionSpan,
} from "../../shared/motion";
import {
	defaultTransition,
	type Layer,
	type TitleTemplate,
	type Transition,
	type TransitionType,
} from "../../shared/types";
import { N_, localNumber, t, type Phrase } from "../i18n";
import { Icon, type IconName } from "../ui";
import {
	LAYER_ICON,
	NumField,
	SelectField,
	TRANSITION_LABEL,
	TRANSITION_TYPES,
	TextField,
	layerDisplayName,
	sortByZ,
} from "./ui";

const PHASES: MotionPhase[] = ["in", "out"];

const PHASE_LABEL: Record<MotionPhase, Phrase> = {
	in: N_("Entrance"),
	out: N_("Exit"),
};

const DEFAULT_EASING: Record<MotionPhase, string> = { in: "ease-out", out: "ease-in" };

/** The row of the animation itself; every other row is a layer id. */
const WHOLE = "";

/** A bar is dragged, and nudged from the keyboard, in steps of this many ms. */
const STEP_MS = 10;

/** The "no transition of its own" choice of a layer. */
const WITH_WHOLE = "with-whole";

function clampMs(value: number, max = MOTION_MAX_MS): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(0, max), Math.max(0, Math.round(value)));
}

/** What a layer gets when it is first given a transition of its own. */
function ownTransition(phase: MotionPhase, patch: Partial<Transition> = {}): Transition {
	return { type: "fade", durationMs: 350, easing: DEFAULT_EASING[phase], delayMs: 0, ...patch };
}

/** A length in seconds, as short as it can be written: "1 s", "0.35 s". */
function seconds(ms: number): string {
	const text = (ms / 1000).toFixed(2).replace(/\.?0+$/, "");
	return `${localNumber(text)} ${t("s")}`;
}

// ------------------------------------------------------- one transition

/**
 * The fields of one transition. A layer may have none of its own (`optional`),
 * and then it only says so; the whole animation always has one.
 */
export function TransitionFields({
	phase,
	value,
	optional,
	onChange,
}: {
	phase: MotionPhase;
	value: Transition | undefined;
	optional: boolean;
	onChange: (next: Transition | undefined) => void;
}) {
	const options = [
		...(optional ? [{ value: WITH_WHOLE, label: t("With the whole animation") }] : []),
		...TRANSITION_TYPES.map((type) => ({ value: type as string, label: t(TRANSITION_LABEL[type]) })),
	];
	// A cut takes no time, so it has a moment and nothing else.
	const cut = value?.type === "none";

	return (
		<div className="ed-motion" data-motion-fields={phase}>
			<SelectField
				label={t(PHASE_LABEL[phase])}
				value={value ? value.type : WITH_WHOLE}
				options={options}
				onChange={(next) => {
					if (next === WITH_WHOLE) {
						onChange(undefined);
						return;
					}
					const from = value ?? ownTransition(phase);
					onChange({
						...from,
						type: next as TransitionType,
						// A cut is stored with no length; a transition picked after
						// it needs one to be seen at all.
						durationMs: next !== "none" && !(from.durationMs > 0) ? 350 : from.durationMs,
					});
				}}
			/>
			{value ? (
				<div className="ed-grid2">
					<NumField
						label={t("Delay")}
						suffix={t("ms")}
						step={STEP_MS}
						min={0}
						max={MOTION_MAX_MS}
						value={value.delayMs ?? 0}
						onChange={(next) => onChange({ ...value, delayMs: clampMs(next) })}
					/>
					{cut ? null : (
						<NumField
							label={t("Duration")}
							suffix={t("ms")}
							step={STEP_MS}
							min={0}
							max={MOTION_MAX_MS}
							value={value.durationMs}
							onChange={(next) => onChange({ ...value, durationMs: clampMs(next) })}
						/>
					)}
				</div>
			) : null}
			{value && !cut ? (
				<TextField
					label={t("Easing (CSS)")}
					value={value.easing}
					placeholder={DEFAULT_EASING[phase]}
					onChange={(next) => onChange({ ...value, easing: next })}
				/>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------- timeline

/** The round lengths the timeline's scale steps through, ms. */
const SCALE_STEPS = [
	1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000,
	90_000, 120_000, 150_000,
];

/** The scale for a phase of `spanMs`: a round length with room left to drag into. */
function scaleFor(spanMs: number): number {
	const wanted = Math.max(1000, spanMs * 1.25);
	return SCALE_STEPS.find((step) => step >= wanted) ?? SCALE_STEPS[SCALE_STEPS.length - 1]!;
}

interface Row {
	/** A layer id, or `WHOLE`. */
	id: string;
	name: string;
	icon: IconName;
	/** A hidden layer: it is listed, but it does not play. */
	dim: boolean;
	own: Record<MotionPhase, Transition | undefined>;
}

/**
 * One transition on the timeline: a bar from its delay to its end. Dragging the
 * bar moves its start, dragging its right edge changes its length, and the
 * arrow keys move the start too.
 */
function MotionBar({
	phase,
	name,
	own,
	whole,
	scale,
	gone,
	onChange,
	onSelect,
	onGrab,
}: {
	phase: MotionPhase;
	/** The row's name, for the bar's own. */
	name: string;
	/** The row's own transition; a layer may have none. */
	own: Transition | undefined;
	/** The whole animation's transition: what a layer without its own follows. */
	whole: Transition;
	/** How many ms the zone is wide. */
	scale: number;
	/** When the whole animation is gone, ms; what a layer does later is not seen. */
	gone: number | null;
	onChange: (next: Transition) => void;
	onSelect: () => void;
	/** A drag began or ended: the scale stands still in between. */
	onGrab: (held: boolean) => void;
}) {
	const zoneRef = useRef<HTMLDivElement | null>(null);
	const drag = useRef<{
		x: number;
		width: number;
		span: MotionSpan;
		edge: boolean;
		moved: boolean;
	} | null>(null);

	const span = transitionSpan(own ?? whole);
	const cut = (own ?? whole).type === "none";
	const phaseName = t(PHASE_LABEL[phase]);
	const percent = (ms: number) => `${Math.min(100, Math.max(0, (ms / scale) * 100))}%`;

	// Moving the bar of a layer that follows the whole animation gives it a
	// transition of its own, as long as the one it was following.
	const base = (from: MotionSpan): Transition =>
		own ?? ownTransition(phase, { durationMs: from.duration || 350, delayMs: from.delay });

	const press = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		const width = zoneRef.current?.getBoundingClientRect().width ?? 0;
		if (width <= 0) return;
		// Captured, so the drag goes on when the pointer leaves the narrow track.
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = {
			x: event.clientX,
			width,
			span,
			edge: (event.target as HTMLElement).dataset["motionEdge"] !== undefined,
			moved: false,
		};
		onSelect();
		onGrab(true);
	};

	const move = (event: ReactPointerEvent<HTMLDivElement>) => {
		const state = drag.current;
		if (!state) return;
		const delta =
			Math.round((((event.clientX - state.x) / state.width) * scale) / STEP_MS) * STEP_MS;
		if (delta === 0 && !state.moved) return;
		state.moved = true;
		const from = base(state.span);
		if (state.edge) {
			onChange({
				...from,
				durationMs: clampMs(state.span.duration + delta, scale - state.span.delay),
			});
		} else {
			onChange({
				...from,
				delayMs: clampMs(state.span.delay + delta, scale - state.span.duration),
			});
		}
	};

	const release = () => {
		if (!drag.current) return;
		drag.current = null;
		onGrab(false);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? STEP_MS * 10 : STEP_MS;
		const delta = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
		if (delta === 0) return;
		// The arrows are the editor's nudge keys everywhere else; here they
		// belong to the bar.
		event.preventDefault();
		event.stopPropagation();
		onChange({ ...base(span), delayMs: clampMs(span.delay + delta) });
	};

	const title = !own
		? t("{phase}: with the whole animation. Drag to give this layer a delay of its own.", {
				phase: phaseName,
			})
		: cut
			? t("{phase}: at once, {delay} ms in", { phase: phaseName, delay: span.delay })
			: t("{phase}: starts {delay} ms in, takes {duration} ms", {
					phase: phaseName,
					delay: span.delay,
					duration: span.duration,
				});

	return (
		<div className="ed-tl__zone" data-phase={phase} ref={zoneRef}>
			<div
				className={`ed-tl__bar${own ? "" : " is-ghost"}${cut ? " is-cut" : ""}`}
				style={{ left: percent(span.delay), width: percent(span.duration) }}
				role="slider"
				tabIndex={0}
				aria-label={t("{name}: {phase}, delay", { name, phase: phaseName })}
				aria-valuemin={0}
				aria-valuemax={MOTION_MAX_MS}
				aria-valuenow={span.delay}
				aria-valuetext={`${span.delay} ${t("ms")}`}
				title={title}
				data-motion-bar={phase}
				onPointerDown={press}
				onPointerMove={move}
				onPointerUp={release}
				onPointerCancel={release}
				onKeyDown={onKeyDown}
				onFocus={onSelect}
			>
				{own && !cut ? <span className="ed-tl__edge" data-motion-edge="" /> : null}
			</div>
			{own && gone !== null && span.end > gone ? (
				<span className="ed-tl__gone" style={{ left: percent(gone) }} />
			) : null}
		</div>
	);
}

/**
 * The whole animation on one timeline, and the transitions of the row that is
 * selected in it.
 *
 * The entrance and the exit share one scale, so their bars compare, but they
 * are two separate clocks: both start at zero, and the time the animation
 * spends on air in between is not drawn.
 */
export function MotionTimeline({
	template,
	focusLayerId,
	onTemplate,
	onLayer,
}: {
	template: TitleTemplate;
	/** The layer selected on the canvas: the timeline opens on its row. */
	focusLayerId: string | null;
	onTemplate: (patch: Partial<TitleTemplate>) => void;
	onLayer: (layerId: string, patch: Partial<Layer>) => void;
}) {
	const [selected, setSelected] = useState<string>(focusLayerId ?? WHOLE);
	// While a bar is dragged the scale stands still, so the bar keeps to the
	// pointer; it is fitted again when the bar is let go.
	const [held, setHeld] = useState<number | null>(null);

	const whole: Record<MotionPhase, Transition> = {
		in: template.inTransition ?? defaultTransition(),
		out: template.outTransition ?? defaultTransition(),
	};
	const rows: Row[] = [
		{ id: WHOLE, name: t("Whole animation"), icon: "layers", dim: false, own: whole },
		// Topmost first, like the layer list.
		...sortByZ(template.layers ?? [])
			.reverse()
			.map((layer) => ({
				id: layer.id,
				name: layerDisplayName(layer),
				icon: LAYER_ICON[layer.type],
				dim: Boolean(layer.hidden),
				own: { in: layer.inTransition, out: layer.outTransition },
			})),
	];
	const current = rows.find((row) => row.id === selected) ?? rows[0]!;

	const total: Record<MotionPhase, number> = {
		in: phaseMs(template, "in"),
		out: phaseMs(template, "out"),
	};
	const fitted = scaleFor(Math.max(total.in, total.out));
	const scale = held ?? fitted;
	const gone = goneAfterMs(template);

	const change = (rowId: string, phase: MotionPhase, next: Transition | undefined) => {
		const key = phase === "in" ? "inTransition" : "outTransition";
		if (rowId !== WHOLE) onLayer(rowId, { [key]: next });
		else if (next) onTemplate({ [key]: next });
	};

	return (
		<div className="ed-tl" data-motion-timeline>
			<div className="ed-tl__head">
				{PHASES.map((phase) => (
					<div key={phase} className="ed-tl__cap" data-phase={phase}>
						<span>{t(PHASE_LABEL[phase])}</span>
						<span className="ed-tl__total" data-motion-total={phase}>
							{seconds(total[phase])}
						</span>
					</div>
				))}
			</div>
			<div className="ed-tl__head" aria-hidden="true">
				{PHASES.map((phase) => (
					<div key={phase} className="ed-tl__ticks">
						<span>0</span>
						<span>{seconds(scale / 2)}</span>
						<span>{seconds(scale)}</span>
					</div>
				))}
			</div>

			<div className="ed-tl__rows">
				{rows.map((row) => (
					<div
						key={row.id}
						className={`ed-tl__row${row.id === current.id ? " is-selected" : ""}${
							row.dim ? " is-hidden" : ""
						}`}
						data-motion-row={row.id || "whole"}
						onClick={() => setSelected(row.id)}
					>
						<div className="ed-tl__name">
							<Icon name={row.icon} size={12} />
							<span>{row.name}</span>
						</div>
						<div className="ed-tl__track">
							{PHASES.map((phase) => (
								<MotionBar
									key={phase}
									phase={phase}
									name={row.name}
									own={row.own[phase]}
									whole={whole[phase]}
									scale={scale}
									gone={phase === "out" && row.id !== WHOLE && !row.dim ? gone : null}
									onChange={(next) => change(row.id, phase, next)}
									onSelect={() => setSelected(row.id)}
									onGrab={(grabbed) => setHeld(grabbed ? scale : null)}
								/>
							))}
						</div>
					</div>
				))}
			</div>

			<p className="ed-hint">
				{t(
					"Drag a bar to set when it starts, and its right edge to set how long it takes. Both sides count from zero: the entrance from the moment of the show, the exit from the moment it is taken off.",
				)}
			</p>
			{gone !== null && total.out > gone ? (
				<p className="ed-hint ed-tl__warn" data-motion-warning>
					{t(
						"The whole animation is gone {time} into the exit, so what a layer does after that is not seen. Move the exit of the whole animation later, or set it to “No transition”.",
						{ time: seconds(gone) },
					)}
				</p>
			) : null}

			<div className="ed-tl__edit" data-motion-edit={current.id || "whole"}>
				<div className="ed-tl__edit-head">
					<Icon name={current.icon} size={14} />
					<span>{current.name}</span>
				</div>
				{PHASES.map((phase) => (
					<TransitionFields
						key={phase}
						phase={phase}
						value={current.own[phase]}
						optional={current.id !== WHOLE}
						onChange={(next) => change(current.id, phase, next)}
					/>
				))}
			</div>
		</div>
	);
}
