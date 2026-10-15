/**
 * The Timers section of the Control panel: every countdown and stopwatch the
 * operator works with, with the buttons that drive it on air and the settings
 * that say what it counts, how it reads and which groups share it.
 *
 * Nothing here writes the `timers` Replicant: every button is a command to the
 * extension (`timerCommand`), so the server's clock decides when a timer
 * started, whatever this browser's clock says.
 */
import { useEffect, useMemo, useState } from "react";

import { TIMER_FORMATS, TIMER_VAR, type Timer, type TimerFormat, parseTimerText, timerVars } from "../shared/timer";
import { N_, t, tr, type Phrase } from "./i18n";
import { createTimer, timerCommand, useMe, useTimerClock, useTimers } from "./shared";
import { CopyButton, Icon, IconButton, NameInput, Segmented, Switch } from "./ui";

/** The nudges under every timer: what they add to what it shows. */
const STEPS: Array<{ ms: number; label: string }> = [
	{ ms: -60_000, label: "−1:00" },
	{ ms: -10_000, label: "−0:10" },
	{ ms: 10_000, label: "+0:10" },
	{ ms: 60_000, label: "+1:00" },
];

const FORMAT_LABEL: Record<TimerFormat, Phrase | null> = {
	auto: N_("Automatic"),
	"hh:mm:ss": null,
	"mm:ss": null,
	ss: N_("Seconds"),
	"mm:ss.t": null,
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** 300000 -> "5:00", 3723000 -> "1:02:03": how a time is typed into a field. */
function timeText(ms: number): string {
	const total = Math.round(Math.abs(ms) / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Why a command failed, in words, from whatever the socket handed back. */
function reason(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error && error.message) return error.message;
	return t("The server did not accept it");
}

/** A time typed as "1:30", "90" or "1:00:00"; committed on Enter or on leaving the field. */
function TimeInput({
	valueMs,
	onCommit,
	label,
	placeholder,
	clearOnCommit,
	emptyMs,
}: {
	valueMs?: number;
	onCommit: (ms: number) => void;
	label: string;
	placeholder?: string;
	/** An action field ("set to …") rather than a setting: empty again once used. */
	clearOnCommit?: boolean;
	/** What an empty field means ("never" = 0); shown empty while it is that. */
	emptyMs?: number;
}) {
	const shown = valueMs === undefined || valueMs === emptyMs ? "" : timeText(valueMs);
	const [draft, setDraft] = useState(shown);
	const [focused, setFocused] = useState(false);
	const [bad, setBad] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(shown);
	}, [shown, focused]);

	const commit = () => {
		if (draft.trim() === "" && emptyMs !== undefined && valueMs !== emptyMs) {
			setBad(false);
			onCommit(emptyMs);
			return;
		}
		if (draft.trim() === "" || draft === shown) {
			setDraft(shown);
			setBad(false);
			return;
		}
		const ms = parseTimerText(draft);
		if (ms === undefined) {
			setBad(true);
			return;
		}
		setBad(false);
		onCommit(ms);
		setDraft(clearOnCommit ? "" : timeText(ms));
	};

	return (
		<input
			type="text"
			inputMode="numeric"
			className={`tmr__time${bad ? " is-bad" : ""}`}
			aria-label={label}
			aria-invalid={bad || undefined}
			title={bad ? t("Type a time as 1:30, 90 or 1:00:00") : label}
			placeholder={placeholder}
			value={draft}
			onFocus={() => setFocused(true)}
			onChange={(event) => {
				setDraft(event.target.value);
				setBad(false);
			}}
			onBlur={() => {
				setFocused(false);
				commit();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") commit();
				if (event.key === "Escape") {
					setDraft(shown);
					setBad(false);
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

type Run = (command: string, params?: Record<string, unknown>) => void;

/** Who sees the timer, in a phrase: "everyone" or the names of the groups. */
function sharedWith(timer: Timer, groups: Array<{ id: string; name: string }>): string {
	if (timer.groups.length === 0) return t("everyone");
	return timer.groups.map((id) => groups.find((group) => group.id === id)?.name ?? id).join(", ");
}

function TimerSettings({
	timer,
	groups,
	run,
}: {
	timer: Timer;
	groups: Array<{ id: string; name: string }>;
	run: Run;
}) {
	const token = `{{${TIMER_VAR}.${timer.key}.text}}`;
	const toggleGroup = (id: string) => {
		const next = timer.groups.includes(id) ? timer.groups.filter((group) => group !== id) : [...timer.groups, id];
		run("update", { groups: next });
	};

	return (
		<div className="tmr__settings">
			<div className="tmr__grid">
				<label className="field">
					{t("Name")}
					<NameInput value={timer.name} label={t("Name")} onCommit={(name) => run("update", { name })} />
				</label>
				<label className="field">
					{t("Variable")}
					<NameInput
						className="ed-mono"
						value={timer.key}
						label={t("Variable")}
						onCommit={(key) => run("update", { key })}
					/>
				</label>
				<div className="field">
					{t("Counts")}
					<Segmented
						label={t("Counts")}
						value={timer.mode}
						options={[
							{ value: "down", label: t("Down") },
							{ value: "up", label: t("Up") },
						]}
						onChange={(mode) => run("update", { mode })}
					/>
				</div>
				<label className="field">
					{timer.mode === "down" ? t("From") : t("Stops at")}
					<TimeInput
						valueMs={timer.durationMs}
						label={timer.mode === "down" ? t("From") : t("Stops at")}
						placeholder={timer.mode === "up" ? t("never") : undefined}
						emptyMs={timer.mode === "up" ? 0 : undefined}
						onCommit={(durationMs) => run("update", { durationMs })}
					/>
				</label>
				<label className="field">
					{t("Format")}
					<select
						value={timer.format}
						onChange={(event) => run("update", { format: event.target.value })}
					>
						{TIMER_FORMATS.map((format) => {
							const label = FORMAT_LABEL[format];
							return (
								<option key={format} value={format}>
									{label ? t(label) : format}
								</option>
							);
						})}
					</select>
				</label>
				{timer.mode === "down" ? (
					<div className="field tmr__overtime">
						<Switch
							checked={timer.overtime}
							label={t("Past zero, keep counting")}
							title={t("After zero the countdown goes on with a minus: −0:05")}
							onChange={(overtime) => run("update", { overtime })}
						/>
					</div>
				) : null}
			</div>

			<div className="tmr__use">
				<span className="hint">
					{tr("In any title: {token} in a text, or a layer bound to {path}. In code: {code}.", {
						token: <code>{token}</code>,
						path: <code>{`${TIMER_VAR}.${timer.key}.text`}</code>,
						code: <code>{`timer("${timer.key}")`}</code>,
					})}
				</span>
				<CopyButton text={token} label={t("Copy")} />
			</div>

			<div className="field">
				{t("Shared with")}
				{groups.length === 0 ? (
					<span className="hint">{t("Everyone. Make groups in the Team panel to share a timer with some of them only.")}</span>
				) : (
					<div className="tmr__groups" role="group" aria-label={t("Shared with")}>
						<button
							type="button"
							className={`small${timer.groups.length === 0 ? " is-on" : ""}`}
							aria-pressed={timer.groups.length === 0}
							onClick={() => run("update", { groups: [] })}
						>
							{t("Everyone")}
						</button>
						{groups.map((group) => (
							<button
								key={group.id}
								type="button"
								className={`small${timer.groups.includes(group.id) ? " is-on" : ""}`}
								aria-pressed={timer.groups.includes(group.id)}
								data-group={group.id}
								onClick={() => toggleGroup(group.id)}
							>
								{group.name}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="row">
				<span className="spacer" />
				<button
					type="button"
					className="danger small"
					onClick={() => {
						if (window.confirm(t("Delete the timer “{name}”? Titles that show it go blank.", { name: timer.name }))) {
							run("remove");
						}
					}}
				>
					<Icon name="trash" size={14} />
					{t("Delete timer")}
				</button>
			</div>
		</div>
	);
}

function TimerCard({ timer, groups }: { timer: Timer; groups: Array<{ id: string; name: string }> }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const one = useMemo(() => [timer], [timer]);
	const now = useTimerClock(one);
	const vars = timerVars(timer, now);

	const run: Run = (command, params = {}) => {
		setError("");
		timerCommand(command, { timer: timer.id, ...params }).catch((failure: unknown) => setError(reason(failure)));
	};

	const summary =
		timer.mode === "down"
			? t("Countdown from {time}", { time: timeText(timer.durationMs) })
			: timer.durationMs > 0
				? t("Stopwatch to {time}", { time: timeText(timer.durationMs) })
				: t("Stopwatch");

	return (
		<div
			className={`tmr${vars.running ? " is-running" : ""}${vars.done ? " is-done" : ""}${vars.overtime ? " is-over" : ""}`}
			data-timer={timer.key}
			data-running={vars.running ? "true" : "false"}
		>
			<div className="tmr__main">
				<span className={`tally${vars.running ? " is-live" : ""}`} aria-hidden="true" />
				<div className="cue__title">
					<span className="cue__name truncate" title={timer.name}>
						{timer.name}
					</span>
					<button
						type="button"
						className="cue__meta"
						aria-expanded={open}
						title={t("Timer settings")}
						onClick={() => setOpen((value) => !value)}
					>
						<span className="truncate">
							{summary} · {sharedWith(timer, groups)}
						</span>
						<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
					</button>
				</div>
				<span className="tmr__face" data-timer-face role="timer" aria-label={timer.name}>
					{vars.text}
				</span>
			</div>
			{timer.durationMs > 0 ? (
				<div className="tmr__bar" aria-hidden="true">
					<span style={{ width: `${(vars.progress * 100).toFixed(2)}%` }} />
				</div>
			) : null}
			<div className="tmr__controls">
				<button
					type="button"
					className={`tmr__go${vars.running ? "" : " primary"}`}
					data-timer-action="toggle"
					onClick={() => run("toggle")}
				>
					<Icon name={vars.running ? "pause" : "play"} size={14} />
					{vars.running ? t("Pause") : vars.done ? t("Start over") : t("Start")}
				</button>
				<IconButton icon="restart" label={t("Reset")} data-timer-action="reset" onClick={() => run("reset")} />
				<span className="tmr__steps">
					{STEPS.map((step) => (
						<button
							key={step.ms}
							type="button"
							className="ghost small"
							data-timer-step={step.ms}
							title={step.ms > 0 ? t("Add {time}", { time: step.label.slice(1) }) : t("Take off {time}", { time: step.label.slice(1) })}
							onClick={() => run("adjust", { deltaMs: step.ms })}
						>
							{step.label}
						</button>
					))}
				</span>
				<span className="spacer" />
				<TimeInput
					label={t("Set the time it shows")}
					placeholder={t("Set…")}
					clearOnCommit
					onCommit={(valueMs) => run("set", { valueMs })}
				/>
			</div>
			{error ? <div className="err tmr__err">{error}</div> : null}
			{open ? <TimerSettings timer={timer} groups={groups} run={run} /> : null}
		</div>
	);
}

export function TimersPanel() {
	const timers = useTimers();
	const me = useMe();
	const groups = me?.allGroups ?? [];
	const [error, setError] = useState("");

	return (
		<section className="panel ctl-timers">
			<header className="panel__head">
				<h2>{t("Timers")}</h2>
				<span className="spacer" />
				<button
					type="button"
					className="ghost small"
					data-timer-new
					onClick={() => {
						setError("");
						createTimer({ name: t("Timer {n}", { n: timers.length + 1 }) }).catch((failure: unknown) =>
							setError(reason(failure)),
						);
					}}
				>
					<Icon name="plus" size={14} />
					{t("New timer")}
				</button>
			</header>
			{timers.length === 0 ? (
				<div className="empty">
					{tr("A countdown or a stopwatch that any title can show, as {token}. Start, pause and nudge it here, from Companion or over the API.", {
						token: <code>{`{{${TIMER_VAR}.<name>.text}}`}</code>,
					})}
				</div>
			) : (
				timers.map((timer) => <TimerCard key={timer.id} timer={timer} groups={groups} />)
			)}
			{error ? <div className="err tmr__err">{error}</div> : null}
		</section>
	);
}
