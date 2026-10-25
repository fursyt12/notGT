/**
 * notGT dashboard — UI atoms shared by the Control, Titles & Outs and Editor
 * panels. React only; the styles live in `dashboard/ui.css`.
 */
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type ReactNode,
} from "react";

import { GALLERY, type GalleryExample } from "../shared/examples/gallery";
import type { OutItem, PlaybackConfig, TitleTemplate } from "../shared/types";
import { LANGS, N_, getLang, localNumber, setLang, t, useLang, type Phrase } from "./i18n";
import { THEMES, setThemeChoice, useTheme, useThemeChoice } from "./theme";
import {
	copyText,
	effectivePlayback,
	hasVideoLayer,
	useVideoDuration,
	videoHoldHint,
	videoLayerSignature,
} from "./shared";

// -------------------------------------------------------------------- icons

const ICONS = {
	play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />,
	pause: <path d="M8 5v14M16 5v14" />,
	plus: <path d="M12 5v14M5 12h14" />,
	x: <path d="M18 6 6 18M6 6l12 12" />,
	up: <path d="M12 19V5M6 11l6-6 6 6" />,
	down: <path d="M12 5v14M18 13l-6 6-6-6" />,
	check: <path d="M5 12.5l4.5 4.5L19 7" />,
	chevronRight: <path d="M9 6l6 6-6 6" />,
	chevronDown: <path d="M6 9l6 6 6-6" />,
	chevronLeft: <path d="M15 6l-6 6 6 6" />,
	more: (
		<>
			<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
			<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
			<circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
		</>
	),
	copy: (
		<>
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M5 15V6a2 2 0 0 1 2-2h9" />
		</>
	),
	trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12M10 11v6M14 11v6" />,
	link: <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3A4.5 4.5 0 0 0 13 4.6l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 19.4l1.2-1.2" />,
	eye: (
		<>
			<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
			<circle cx="12" cy="12" r="2.6" />
		</>
	),
	eyeOff: <path d="M4 4l16 16M9.9 6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.3 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 3.7-.8M10 10a2.8 2.8 0 0 0 4 4" />,
	lock: (
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 8 0v3" />
		</>
	),
	unlock: (
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 7.6-1.7" />
		</>
	),
	crop: <path d="M6 2v13a3 3 0 0 0 3 3h13M2 6h13a3 3 0 0 1 3 3v13" />,
	bounds: (
		<>
			<rect x="8" y="8" width="8" height="8" rx="1" />
			<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" />
		</>
	),
	corners: (
		<>
			<path d="M5 6l14-2-1 16-12-3z" />
			<circle cx="5" cy="6" r="1.8" />
			<circle cx="19" cy="4" r="1.8" />
			<circle cx="18" cy="20" r="1.8" />
			<circle cx="6" cy="17" r="1.8" />
		</>
	),
	sliders: (
		<>
			<path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
			<circle cx="15" cy="7" r="2.4" />
			<circle cx="9" cy="17" r="2.4" />
		</>
	),
	restart: <path d="M4 5v5h5M4.6 10A8 8 0 1 1 4 13" />,
	swap: <path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5" />,
	fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
	text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
	shape: <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />,
	image: (
		<>
			<rect x="3.5" y="4.5" width="17" height="15" rx="2" />
			<circle cx="9" cy="10" r="1.6" />
			<path d="M20.5 15.5l-4.5-4.5-8 8" />
		</>
	),
	gif: (
		<>
			<rect x="3.5" y="5.5" width="17" height="13" rx="2" />
			<path d="M10 10H8.5a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1H10v-2M13 10v4M16 14v-4h2.2M16 12h1.8" />
		</>
	),
	video: (
		<>
			<rect x="3.5" y="5.5" width="13" height="13" rx="2" />
			<path d="M16.5 10.5l4-2.5v8l-4-2.5" />
		</>
	),
	code: <path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5" />,
	timer: (
		<>
			<circle cx="12" cy="13.5" r="7.5" />
			<path d="M12 9.5v4l2.5 2M10 2.5h4M18.5 6l1.5-1.5" />
		</>
	),
	layers: <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12.5l8.5 4.5 8.5-4.5M3.5 16.5L12 21l8.5-4.5" />,
	list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
	spark: <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 16v4M17 18h4" />,
	table: <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />,
	expand: <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />,
	collapse: <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />,
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
		</>
	),
	moon: <path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z" />,
	download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
	upload: <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />,
	file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />,
	/** Empty: keeps the labels of a menu aligned next to items that have an icon. */
	blank: null,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	return (
		<svg
			className="ico"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{ICONS[name]}
		</svg>
	);
}

/** A square button that is only an icon; `label` is its tooltip and its name. */
export function IconButton({
	icon,
	label,
	className,
	size,
	...rest
}: {
	icon: IconName;
	label: string;
	size?: number;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			className={`icon ghost${className ? ` ${className}` : ""}`}
			title={label}
			aria-label={label}
			{...rest}
		>
			<Icon name={icon} size={size} />
		</button>
	);
}

// --------------------------------------------------------------------- menu

export interface MenuItem {
	label: string;
	/** Second line under the label. */
	hint?: string;
	icon?: IconName;
	danger?: boolean;
	disabled?: boolean;
	onSelect?: () => void;
	/** Opens a second level instead of running an action. */
	children?: MenuItem[];
	/** Draws a divider above this item. */
	separated?: boolean;
}

/**
 * A button that opens a small list of actions. The list is `position: fixed`
 * and placed from the trigger's box, so a scrolling sidebar never clips it.
 */
export function Menu({
	items,
	label,
	icon = "more",
	children,
	className,
}: {
	items: MenuItem[];
	/** Tooltip / accessible name of the trigger. */
	label: string;
	icon?: IconName;
	/** Trigger content; without it the trigger is an icon button. */
	children?: ReactNode;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [sub, setSub] = useState<MenuItem | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const hasContent = Boolean(children);

	const close = () => {
		setOpen(false);
		setSub(null);
		setPos(null);
	};

	useLayoutEffect(() => {
		if (!open) return;
		const trigger = triggerRef.current?.getBoundingClientRect();
		const list = listRef.current?.getBoundingClientRect();
		if (!trigger || !list) return;
		const gap = 4;
		const edge = 8;
		// A text trigger reads as a dropdown and opens from its left edge; an
		// icon trigger sits at the end of a row, so its list hangs to the left.
		let left = hasContent ? trigger.left : trigger.right - list.width;
		left = Math.min(Math.max(edge, left), window.innerWidth - list.width - edge);
		let top = trigger.bottom + gap;
		if (top + list.height > window.innerHeight - edge) {
			top = Math.max(edge, trigger.top - list.height - gap);
		}
		setPos({ left, top });
	}, [open, sub, hasContent]);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				// Marked as used: the key closed the menu and nothing behind it.
				event.preventDefault();
				close();
				triggerRef.current?.focus();
			}
		};
		const onScroll = (event: Event) => {
			if (listRef.current?.contains(event.target as Node)) return;
			close();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	const shown = sub?.children ?? items;

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={children ? className : `icon ghost${className ? ` ${className}` : ""}`}
				title={children ? undefined : label}
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={(event) => {
					event.stopPropagation();
					if (open) close();
					else setOpen(true);
				}}
			>
				{children ?? <Icon name={icon} />}
			</button>
			{open ? (
				<div
					ref={listRef}
					className="menu__list"
					role="menu"
					style={pos ? pos : { left: 0, top: 0, visibility: "hidden" }}
					onClick={(event) => event.stopPropagation()}
				>
					{sub ? (
						<>
							<button
								type="button"
								className="menu__item menu__back"
								onClick={() => setSub(null)}
							>
								<Icon name="chevronLeft" />
								<span className="menu__text">{sub.label}</span>
							</button>
							<div className="menu__sep" />
						</>
					) : null}
					{shown.length === 0 ? <div className="empty">{t("Empty")}</div> : null}
					{shown.map((item, index) => (
						<div key={`${item.label}:${index}`}>
							{item.separated ? <div className="menu__sep" /> : null}
							<button
								type="button"
								role="menuitem"
								className={`menu__item${item.danger ? " menu__item--danger" : ""}`}
								disabled={item.disabled}
								onClick={() => {
									if (item.children) {
										setSub(item);
										return;
									}
									close();
									item.onSelect?.();
								}}
							>
								{item.icon ? <Icon name={item.icon} /> : null}
								<span className="menu__text">
									<span>{item.label}</span>
									{item.hint ? <span className="menu__hint">{item.hint}</span> : null}
								</span>
								{item.children ? <Icon name="chevronRight" size={14} /> : null}
							</button>
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

/** The "from an example" entry of a "new animation" menu: the whole gallery. */
export function exampleMenuItem(onPick: (example: GalleryExample) => void): MenuItem {
	const lang = getLang();
	return {
		label: t("From an example"),
		hint: t("Ready-made animations: add one, take it apart, make it yours"),
		icon: "spark",
		separated: true,
		children: GALLERY.map((example) => ({
			label: example.name[lang],
			hint: example.summary[lang],
			icon: example.kind === "code" ? "code" : "layers",
			onSelect: () => onPick(example),
		})),
	};
}

/** The language of the dashboard; the choice is shared by all three panels. */
export function LangSwitch() {
	const lang = useLang();
	return (
		<Menu
			className="ghost small"
			label={t("Interface language")}
			items={LANGS.map((item) => ({
				label: item.label,
				icon: item.id === lang ? "check" : "blank",
				onSelect: () => setLang(item.id),
			}))}
		>
			{lang.toUpperCase()}
		</Menu>
	);
}

/** The colour theme of the dashboard; the choice is shared by the panels and the shell. */
export function ThemeSwitch() {
	const choice = useThemeChoice();
	const theme = useTheme();
	return (
		<Menu
			className="ghost small"
			label={t("Interface theme")}
			items={THEMES.map((item) => ({
				label: t(item.label),
				icon: item.id === choice ? "check" : "blank",
				onSelect: () => setThemeChoice(item.id),
			}))}
		>
			<Icon name={theme === "light" ? "sun" : "moon"} size={14} />
		</Menu>
	);
}

// ------------------------------------------------------------------ controls

export function Switch({
	checked,
	onChange,
	label,
	title,
	className,
	live,
	...rest
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label?: string;
	title?: string;
	className?: string;
	/** Paints the "on" state in the on-air red instead of the accent. */
	live?: boolean;
	[data: `data-${string}`]: string | undefined;
}) {
	return (
		<label
			className={`switch${live ? " switch--live" : ""}${checked ? " is-on" : ""}${
				className ? ` ${className}` : ""
			}`}
			title={title}
			{...rest}
		>
			{label ? <span className="switch__label">{label}</span> : null}
			<input
				type="checkbox"
				role="switch"
				aria-label={label ?? title}
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span className="switch__track">
				<span className="switch__thumb" />
			</span>
		</label>
	);
}

export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
	label: string;
}) {
	return (
		<div className="seg" role="radiogroup" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					className={option.value === value ? "is-on" : undefined}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** Section that folds away; remembers whether it was left open. */
export function Disclosure({
	title,
	storageKey,
	defaultOpen = false,
	children,
}: {
	title: string;
	storageKey?: string;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(() => {
		if (!storageKey) return defaultOpen;
		try {
			const stored = window.localStorage.getItem(storageKey);
			return stored === null ? defaultOpen : stored === "1";
		} catch {
			return defaultOpen;
		}
	});

	const toggle = () => {
		setOpen((value) => {
			const next = !value;
			if (storageKey) {
				try {
					window.localStorage.setItem(storageKey, next ? "1" : "0");
				} catch {
					// Storage is a convenience; the section still works without it.
				}
			}
			return next;
		});
	};

	return (
		<div className={`disclosure${open ? " is-open" : ""}`}>
			<button
				type="button"
				className="disclosure__head"
				aria-expanded={open}
				onClick={toggle}
			>
				<Icon name="chevronRight" size={14} />
				{title}
			</button>
			{open ? children : null}
		</div>
	);
}

/** Text input that commits on blur / Enter and reverts on Escape. */
export function NameInput({
	value,
	onCommit,
	label,
	className,
}: {
	value: string;
	onCommit: (value: string) => void;
	label: string;
	className?: string;
}) {
	const [draft, setDraft] = useState(value);
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(value);
	}, [value, focused]);

	return (
		<input
			className={`name-input${className ? ` ${className}` : ""}`}
			aria-label={label}
			title={label}
			value={draft}
			onFocus={() => setFocused(true)}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				setFocused(false);
				const next = draft.trim();
				if (next && next !== value) onCommit(next);
				else setDraft(value);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") {
					setDraft(value);
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

function secondsText(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return localNumber(String(Number((ms / 1000).toFixed(2))));
}

/** A duration stored in milliseconds, edited in seconds ("5 с"). */
export function SecondsInput({
	valueMs,
	onCommit,
	minMs = 0,
	disabled,
	label,
}: {
	valueMs: number | undefined;
	onCommit: (ms: number) => void;
	minMs?: number;
	disabled?: boolean;
	label: string;
}) {
	const [draft, setDraft] = useState(secondsText(valueMs));
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(secondsText(valueMs));
	}, [valueMs, focused]);

	const commit = () => {
		const parsed = Number(draft.replace(",", ".").trim());
		if (draft.trim() === "" || !Number.isFinite(parsed)) {
			setDraft(secondsText(valueMs));
			return;
		}
		const next = Math.max(minMs, Math.round(parsed * 1000));
		if (next !== valueMs) onCommit(next);
		setDraft(secondsText(next));
	};

	return (
		<span className="unit-input">
			<input
				type="text"
				inputMode="decimal"
				aria-label={label}
				data-hold-ms
				disabled={disabled}
				value={draft}
				onFocus={() => setFocused(true)}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					setFocused(false);
					commit();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
			<span className="unit-input__unit">{t("s")}</span>
		</span>
	);
}

export function CopyButton({
	text,
	label,
	className = "ghost small",
}: {
	text: string;
	label: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);

	useEffect(() => () => window.clearTimeout(timer.current), []);

	return (
		<button
			type="button"
			className={className}
			title={text}
			onClick={() => {
				void copyText(text).then(() => {
					setCopied(true);
					window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			<Icon name={copied ? "check" : "link"} size={14} />
			{copied ? t("Copied") : label}
		</button>
	);
}

// ----------------------------------------------------------------- playback

/*
 * The stored `mode` is `once` / `loop`, but nothing loops: the scheduler never
 * repeats a placement. What the field really decides is how a placement gets on
 * air — by "Play" for a set time, or only by the on-air switch — so that is
 * what the dashboard calls it.
 */
const PLAYBACK_MODES: Array<{ value: PlaybackConfig["mode"]; label: Phrase }> = [
	{ value: "once", label: N_("Timed") },
	{ value: "loop", label: N_("Until switched off") },
];

/** "5 с" / "до выключения" — how long a placement stays on air, in a phrase. */
export function playbackSummary(item: OutItem, template: TitleTemplate | undefined): string {
	const playback = effectivePlayback(item, template);
	if (playback.mode === "loop") return t("until switched off");
	if (playback.holdMode === "video" && hasVideoLayer(template)) return t("as long as the video");
	return t("{n} s", { n: secondsText(playback.holdMs) });
}

/**
 * How a placement goes on air (or a template's defaults for it): for a set
 * time by "Play", or until the on-air switch is turned off. The hold fields
 * only exist for the timed kind, and "as long as the video" only when the
 * animation actually has a video layer.
 */
export function PlaybackFields({
	playback,
	template,
	scope,
	onChange,
}: {
	playback: PlaybackConfig;
	template: TitleTemplate | undefined;
	/** Which settings these are; only used to tell them apart in the DOM. */
	scope: "item" | "placement" | "template";
	onChange: (patch: Partial<PlaybackConfig>) => void;
}) {
	const isLoop = playback.mode === "loop";
	const videoMode = !isLoop && playback.holdMode === "video";
	const hasVideo = hasVideoLayer(template);
	const videoDuration = useVideoDuration(
		template?.id ?? "",
		videoMode && hasVideo,
		videoLayerSignature(template),
	);

	return (
		<div className="playback" data-hold-scope={scope}>
			<Segmented
				label={t("How long it stays on air")}
				value={playback.mode}
				options={PLAYBACK_MODES.map((mode) => ({ value: mode.value, label: t(mode.label) }))}
				onChange={(mode) => onChange({ mode })}
			/>
			{isLoop ? (
				<span className="hint" data-loop-hint>
					{t("No “Play” button: it is on air for as long as the switch is on.")}
				</span>
			) : (
				<>
					<label className="playback__hold">
						{t("Hold")}
						<SecondsInput
							label={t("Hold, seconds")}
							valueMs={playback.holdMs}
							minMs={100}
							disabled={videoMode}
							onCommit={(holdMs) => onChange({ holdMs })}
						/>
					</label>
					{hasVideo || videoMode ? (
						<label className="check muted">
							<input
								type="checkbox"
								data-hold-mode
								checked={videoMode}
								onChange={(event) =>
									onChange({ holdMode: event.target.checked ? "video" : "fixed" })
								}
							/>
							{t("As long as the video")}
						</label>
					) : null}
					{videoMode ? (
						<span className="hint" data-hold-hint>
							{videoHoldHint(videoDuration, hasVideo)}
						</span>
					) : null}
				</>
			)}
		</div>
	);
}
