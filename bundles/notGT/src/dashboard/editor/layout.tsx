/**
 * The Editor's own layout: how wide the two side bars are, how tall the code
 * dock is, and whether the desk fills the screen.
 *
 * The bars are dragged by the splitters on their inner edges. A size is a
 * preference of this browser, so it is kept in localStorage; a bar that was
 * never dragged has no stored size and follows the stylesheet.
 */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";

export type LayoutEdge = "left" | "right" | "dock";
export type EditorLayout = Partial<Record<LayoutEdge, number>>;

const STORAGE_KEY = "notgt.editor.layout";

/** The least and the most a bar can be dragged to, in px. */
const LIMITS: Record<LayoutEdge, [number, number]> = {
	left: [200, 560],
	right: [260, 640],
	dock: [120, 900],
};

/** What is always left for the desk, in px. */
const DESK_MIN_WIDTH = 320;
const DESK_MIN_HEIGHT = 180;
/** The toolbar above the desk and the dock's own bar. */
const CHROME_HEIGHT = 48 + 40 + 28;

const KEY_STEP = 16;
/** Two presses without a drag, this close together, are a double click. */
const DOUBLE_PRESS_MS = 400;

function readLayout(): EditorLayout {
	try {
		const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
		if (!stored || typeof stored !== "object") return {};
		const layout: EditorLayout = {};
		for (const edge of Object.keys(LIMITS) as LayoutEdge[]) {
			const value = (stored as Record<string, unknown>)[edge];
			if (typeof value === "number" && Number.isFinite(value)) layout[edge] = value;
		}
		return layout;
	} catch {
		return {};
	}
}

function clamp(edge: LayoutEdge, size: number, layout: EditorLayout): number {
	const [min, max] = LIMITS[edge];
	const room =
		edge === "dock"
			? window.innerHeight - CHROME_HEIGHT - DESK_MIN_HEIGHT
			: window.innerWidth -
				DESK_MIN_WIDTH -
				(layout[edge === "left" ? "right" : "left"] ?? LIMITS[edge === "left" ? "right" : "left"][0]);
	return Math.round(Math.max(min, Math.min(size, max, room)));
}

export function useEditorLayout(): {
	/** Custom properties for `.ed-main`; only the bars that were dragged. */
	style: CSSProperties;
	resize: (edge: LayoutEdge, size: number) => void;
	reset: (edge: LayoutEdge) => void;
} {
	const [layout, setLayout] = useState<EditorLayout>(readLayout);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
		} catch {
			// The sizes still hold for this page.
		}
	}, [layout]);

	const resize = useCallback((edge: LayoutEdge, size: number) => {
		setLayout((current) => {
			const next = clamp(edge, size, current);
			return current[edge] === next ? current : { ...current, [edge]: next };
		});
	}, []);

	const reset = useCallback((edge: LayoutEdge) => {
		setLayout((current) => {
			if (current[edge] === undefined) return current;
			const { [edge]: _dropped, ...rest } = current;
			return rest;
		});
	}, []);

	const style: Record<string, string> = {};
	if (layout.left !== undefined) style["--ed-left"] = `${layout.left}px`;
	if (layout.right !== undefined) style["--ed-right"] = `${layout.right}px`;
	if (layout.dock !== undefined) style["--ed-dock"] = `${layout.dock}px`;

	return { style: style as CSSProperties, resize, reset };
}

/**
 * The draggable edge of a bar. `measure` returns the bar's size right now, so a
 * drag starts from what is on screen whether or not the bar was sized before.
 * Arrow keys move it too; a double click gives the bar its own size back.
 */
export function Splitter({
	edge,
	label,
	title,
	measure,
	onResize,
	onReset,
}: {
	edge: LayoutEdge;
	/** Accessible name. */
	label: string;
	title: string;
	measure: () => number;
	onResize: (edge: LayoutEdge, size: number) => void;
	onReset: (edge: LayoutEdge) => void;
}) {
	const drag = useRef<{ pointer: number; size: number; moved: boolean; at: number } | null>(null);
	// When the edge was last pressed and let go without being dragged. The
	// double click is told from this rather than from `dblclick`, which a
	// captured pointer does not reliably produce.
	const lastPress = useRef(0);
	const [dragging, setDragging] = useState(false);
	const vertical = edge !== "dock";
	// Dragging towards the desk makes the bar bigger: right for the left bar,
	// left for the right one, up for the dock.
	const towards = edge === "left" ? 1 : -1;

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		// Captured, so the drag keeps going over the canvas and over the live
		// frames, which would otherwise take the pointer.
		event.currentTarget.setPointerCapture(event.pointerId);
		if (lastPress.current > 0 && event.timeStamp - lastPress.current < DOUBLE_PRESS_MS) {
			lastPress.current = 0;
			onReset(edge);
			return;
		}
		drag.current = {
			pointer: vertical ? event.clientX : event.clientY,
			size: measure(),
			moved: false,
			at: event.timeStamp,
		};
		setDragging(true);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		const pointer = vertical ? event.clientX : event.clientY;
		if (pointer === drag.current.pointer && !drag.current.moved) return;
		drag.current.moved = true;
		onResize(edge, drag.current.size + (pointer - drag.current.pointer) * towards);
	};

	const stop = () => {
		lastPress.current = drag.current && !drag.current.moved ? drag.current.at : 0;
		drag.current = null;
		setDragging(false);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const forward = vertical ? "ArrowRight" : "ArrowDown";
		const back = vertical ? "ArrowLeft" : "ArrowUp";
		if (event.key !== forward && event.key !== back) return;
		event.preventDefault();
		onResize(edge, measure() + (event.key === forward ? KEY_STEP : -KEY_STEP) * towards);
	};

	return (
		<div
			className={`ed-split ed-split--${edge}${dragging ? " is-dragging" : ""}`}
			role="separator"
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-label={label}
			title={title}
			tabIndex={0}
			data-split={edge}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={stop}
			onPointerCancel={stop}
			onKeyDown={onKeyDown}
		/>
	);
}

/**
 * Full screen for the desk. The browser's own full screen is asked for first;
 * where a page may not have it (a frame without the permission), the desk
 * fills the panel instead. Escape leaves either.
 */
export function useDeskFullscreen(): {
	/** Ref callback for the desk element. */
	deskRef: (element: HTMLElement | null) => void;
	active: boolean;
	/** True when the desk fills the panel rather than the screen. */
	filled: boolean;
	toggle: () => void;
} {
	const [desk, setDesk] = useState<HTMLElement | null>(null);
	const [native, setNative] = useState(false);
	const [filled, setFilled] = useState(false);

	useEffect(() => {
		const sync = () => setNative(desk !== null && document.fullscreenElement === desk);
		sync();
		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, [desk]);

	useEffect(() => {
		if (!filled) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFilled(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [filled]);

	const toggle = useCallback(() => {
		if (native) {
			void document.exitFullscreen();
			return;
		}
		if (filled) {
			setFilled(false);
			return;
		}
		if (desk && document.fullscreenEnabled && typeof desk.requestFullscreen === "function") {
			desk.requestFullscreen().catch(() => setFilled(true));
		} else {
			setFilled(true);
		}
	}, [desk, native, filled]);

	return { deskRef: setDesk, active: native || filled, filled, toggle };
}
