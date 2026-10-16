/**
 * notGT — Titles & Outs dashboard panel (fullbleed): setup only.
 *
 * Left: the outs — name, size, the OBS address, whether it also goes out over
 * NDI, and which animations sit on each. Right: the animation library. Where a placement sits and how it plays
 * is edited where it can be seen: on the canvas in the Editor, and next to the
 * on-air switch in Control.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { collectBindingPaths } from "../shared/binding";
import {
	NDI_FPS,
	NDI_SCALES,
	type NdiOutStatus,
	type NdiSenderStatus,
	cleanNdiGroups,
	ndiAlpha,
	ndiFps,
	ndiFpsLabel,
	ndiReportsFor,
	ndiScale,
	ndiSize,
	ndiSourceName,
} from "../shared/ndi";
import { TEAM_BASE } from "../shared/team";
import type { Out, OutItem, TitleTemplate } from "../shared/types";
import { N_, getLang, t, tr, useLang, type Phrase } from "./i18n";
import {
	addExample,
	addItem,
	clone,
	createOut,
	deleteOut,
	deleteTemplate,
	duplicateTemplate,
	itemCanPlay,
	moveItem,
	newTemplate,
	removeItem,
	saveOut,
	saveTemplate,
	triggerItem,
	updateItem,
	updateOutNdi,
	useIsAdmin,
	useMe,
	useNdiStatus,
	useOutUrl,
	useOuts,
	useRuntime,
	useTemplates,
} from "./shared";
import {
	CopyButton,
	Icon,
	IconButton,
	LangSwitch,
	ThemeSwitch,
	Menu,
	NameInput,
	Switch,
	exampleMenuItem,
	playbackSummary,
	type MenuItem,
} from "./ui";

const KIND_LABEL: Record<TitleTemplate["kind"], Phrase> = {
	layers: N_("layers"),
	code: N_("code"),
};

/** Pixel size of an out; commits on blur / Enter. */
function SizeInput({
	value,
	label,
	onCommit,
}: {
	value: number;
	label: string;
	onCommit: (next: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(String(value));
	}, [value, focused]);

	return (
		<input
			className="tt-size"
			type="number"
			min={1}
			aria-label={label}
			title={label}
			value={draft}
			onFocus={() => setFocused(true)}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				setFocused(false);
				const parsed = Math.round(Number(draft));
				if (Number.isFinite(parsed) && parsed >= 1 && parsed !== value) onCommit(parsed);
				else setDraft(String(value));
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
}

// ---------------------------------------------------------------------- ndi

function ndiReport(sender: NdiSenderStatus, out: NdiOutStatus): { text: string; tone: "ok" | "warn" | "muted" } {
	const where = sender.host;
	if (out.state === "error") return { text: `${where}: ${out.error ?? t("error")}`, tone: "warn" };
	if (out.state === "loading") return { text: t("Opening on {host}…", { host: where }), tone: "muted" };
	if (out.state === "idle") return { text: t("Ready on {host}, nobody receives it", { host: where }), tone: "muted" };
	return {
		text: t("Sending from {host} · receivers: {count} · {fps} fps", {
			host: where,
			count: String(out.connections),
			fps: String(out.fps),
		}),
		tone: "ok",
	};
}

/** Free text that commits on blur / Enter and may be left empty. */
function TextField({
	value,
	label,
	placeholder,
	onCommit,
}: {
	value: string;
	label: string;
	placeholder?: string;
	onCommit: (next: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const [focused, setFocused] = useState(false);

	useEffect(() => {
		if (!focused) setDraft(value);
	}, [value, focused]);

	return (
		<input
			aria-label={label}
			placeholder={placeholder}
			value={draft}
			onFocus={() => setFocused(true)}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				setFocused(false);
				if (draft.trim() !== value) onCommit(draft.trim());
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

type NdiPatch = Partial<NonNullable<Out["ndi"]>>;

/** Everything about how an out goes out over NDI. A change restarts the source. */
function NdiSettings({ out, set }: { out: Out; set: (patch: NdiPatch) => void }) {
	const fallbackName = `notGT ${out.name}`;
	// An API client may have written 0.6667 for ⅔: show the nearest choice.
	const scale = ndiScale(out);
	const chosenScale = NDI_SCALES.reduce<number>(
		(best, candidate) => (Math.abs(candidate - scale) < Math.abs(best - scale) ? candidate : best),
		NDI_SCALES[0],
	);
	const fps = ndiFps(out);
	const rates: number[] = (NDI_FPS as readonly number[]).includes(fps)
		? [...NDI_FPS]
		: [...NDI_FPS, fps].sort((a, b) => a - b);

	return (
		<div className="tt-ndi__settings" data-ndi-settings={out.id}>
			<div className="tt-ndi__grid">
				<label className="field tt-ndi__wide">
					{t("NDI source name")}
					<NameInput
						className="tt-ndi__name"
						label={t("NDI source name")}
						value={ndiSourceName(out)}
						onCommit={(name) => set({ name: name === fallbackName ? undefined : name })}
					/>
				</label>
				<label className="field">
					{t("Picture size")}
					<select
						aria-label={t("NDI picture size")}
						data-ndi-scale
						value={String(chosenScale)}
						onChange={(event) => set({ scale: Number(event.target.value) })}
					>
						{NDI_SCALES.map((option) => {
							const size = ndiSize({ ...out, ndi: { enabled: true, scale: option } });
							return (
								<option key={option} value={String(option)}>
									{size.width}×{size.height}
									{option === 1 ? ` — ${t("the out's size")}` : ""}
								</option>
							);
						})}
					</select>
				</label>
				<label className="field">
					{t("Frame rate")}
					<select
						aria-label={t("NDI frame rate")}
						data-ndi-fps
						value={String(fps)}
						onChange={(event) => set({ fps: Number(event.target.value) })}
					>
						{rates.map((rate) => (
							<option key={rate} value={String(rate)}>
								{t("{fps} fps", { fps: ndiFpsLabel(rate) })}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					{t("NDI groups")}
					<TextField
						label={t("NDI groups")}
						placeholder="public"
						value={out.ndi?.groups ?? ""}
						onCommit={(groups) => set({ groups: cleanNdiGroups(groups) || undefined })}
					/>
				</label>
				<div className="field tt-ndi__alpha">
					<Switch
						checked={ndiAlpha(out)}
						label={t("Transparency")}
						title={t("Off: the picture goes out opaque, over black — lighter to send and to receive")}
						data-ndi-alpha={out.id}
						onChange={(alpha) => set({ alpha: alpha ? undefined : false })}
					/>
				</div>
			</div>
			<span className="hint">
				{t(
					"Receivers list it as “<computer> (name)”. A smaller picture and a lower rate cost much less — on a Raspberry Pi start with 1280×720 or 960×540. A change restarts the source for a moment.",
				)}
			</span>
		</div>
	);
}

/** The out as an NDI source: on or off, how it goes, and its settings behind a button. */
function NdiRow({ out }: { out: Out }) {
	const status = useNdiStatus();
	const [open, setOpen] = useState(false);
	const ndi = out.ndi ?? { enabled: false };
	const set = (patch: NdiPatch) => updateOutNdi(out.id, patch);
	const reports = ndiReportsFor(status, out.id);
	const size = ndiSize(out);
	const summary = [
		ndiSourceName(out),
		`${size.width}×${size.height}`,
		t("{fps} fps", { fps: ndiFpsLabel(ndiFps(out)) }),
		ndiAlpha(out) ? "" : t("no transparency"),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className={`tt-ndi${ndi.enabled ? " is-on" : ""}`} data-ndi={out.id}>
			<div className="tt-ndi__line">
				<Switch
					checked={ndi.enabled}
					label="NDI"
					title={t("Also send this out as an NDI source")}
					onChange={(enabled) => set({ enabled })}
				/>
				<button
					type="button"
					className="ghost small tt-ndi__open grow"
					aria-expanded={open}
					data-ndi-open={out.id}
					title={t("NDI settings")}
					onClick={() => setOpen((value) => !value)}
				>
					<Icon name="sliders" size={14} />
					<span className="truncate grow">
						{ndi.enabled ? summary : t("For Resolume Arena, vMix and other programs that take NDI")}
					</span>
					<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
				</button>
			</div>
			{open ? <NdiSettings out={out} set={set} /> : null}
			{ndi.enabled ? (
				<div className="tt-ndi__status">
					{reports.length === 0 ? (
						<span className="tt-ndi__state is-warn">{t("No NDI sender has picked it up yet — see “NDI senders” below")}</span>
					) : (
						reports.map(({ sender, out: report }) => {
							const { text, tone } = ndiReport(sender, report);
							return (
								<span key={sender.id} className={`tt-ndi__state is-${tone}`} title={`${report.ndiName} · ${report.width}×${report.height}`}>
									{text}
								</span>
							);
						})
					)}
				</div>
			) : null}
		</div>
	);
}

/** The senders that report, and how to start one. */
function NdiSenders({ outs }: { outs: Out[] }) {
	const status = useNdiStatus();
	const me = useMe();
	const admin = useIsAdmin();
	const senders = Object.values(status);
	const wanted = outs.some((out) => out.ndi?.enabled);
	if (!wanted && senders.length === 0) return null;

	const key = me?.ndiKey;
	const command = `cd ndi && npm start -- --server ${window.location.origin}${key ? ` --token ${key}` : ""}`;

	const renew = () => {
		if (!window.confirm(t("Make a new key for the NDI senders? Senders started with the old one stop."))) return;
		void fetch(`${TEAM_BASE}/ndi/key`, { method: "POST", headers: { accept: "application/json" } });
	};

	return (
		<section className="panel tt-ndi-senders">
			<header className="panel__head">
				<h3 className="grow">{t("NDI senders")}</h3>
				{admin && key ? (
					<Menu
						label={t("Actions: {name}", { name: t("NDI senders") })}
						items={[{ label: t("Make a new sender key"), icon: "swap", onSelect: renew }]}
					/>
				) : null}
			</header>
			{senders.length === 0 ? (
				<div className="tt-ndi-senders__row hint">
					{t(
						"None is running. The notGT launcher on Windows and Docker Compose with the ndi profile start one together with the server; on another machine, run the command below.",
					)}
				</div>
			) : (
				senders.map((sender) => (
					<div key={sender.id} className="tt-ndi-senders__row" data-sender={sender.id}>
						<span className="tally is-live" aria-hidden="true" />
						<span className="grow truncate">
							<strong>{sender.host}</strong>
							<span className="hint">
								{" "}
								· {sender.platform} · NDI {sender.ndi.replace(/^.*?(\d+\.\d+\.\d+).*$/, "$1")}
							</span>
						</span>
						<span className="hint">{t("outs: {count}", { count: String(sender.outs.length) })}</span>
					</div>
				))
			)}
			{admin ? (
				<div className="tt-ndi-senders__how">
					<span className="hint">
						{t(
							"A sender renders the outs with NDI switched on and sends them to the network. Run it on this computer or another one — a Raspberry Pi will do — with the NDI runtime installed:",
						)}
					</span>
					<div className="tt-url">
						<input
							readOnly
							className="mono"
							aria-label={t("Command that starts an NDI sender")}
							value={command}
							onFocus={(event) => event.target.select()}
						/>
						<CopyButton text={command} label={t("Copy")} className="small" />
					</div>
					{!key ? (
						<span className="hint">{t("When the server has an `apiToken`, add `--token <apiToken>`.")}</span>
					) : null}
				</div>
			) : null}
		</section>
	);
}

// --------------------------------------------------------------------- outs

function PlacementRow({
	out,
	item,
	index,
	count,
	playing,
}: {
	out: Out;
	item: OutItem;
	index: number;
	count: number;
	playing: boolean;
}) {
	const templates = useTemplates();
	const template = templates.find((candidate) => candidate.id === item.templateId);
	const name = template?.name ?? item.templateId;

	const menu: MenuItem[] = [
		{
			label: t("Play once"),
			icon: "play",
			disabled: !itemCanPlay(item, template),
			onSelect: () => triggerItem(out.id, item.id),
		},
		{
			label: t("Replace the animation"),
			hint: t("Position and settings stay"),
			icon: "swap",
			children: templates
				.filter((candidate) => candidate.id !== item.templateId)
				.map((candidate) => ({
					label: candidate.name,
					onSelect: () => updateItem(out.id, item.id, { templateId: candidate.id }),
				})),
		},
		{
			label: item.enabled ? t("Turn API start off") : t("Turn API start on"),
			hint: t("Start by animation name: Companion, REST"),
			icon: item.enabled ? "eyeOff" : "eye",
			onSelect: () => updateItem(out.id, item.id, { enabled: !item.enabled }),
		},
		{
			label: t("Remove from out"),
			icon: "trash",
			danger: true,
			separated: true,
			onSelect: () => removeItem(out.id, item.id),
		},
	];

	return (
		<div
			className={`tt-row${item.enabled ? "" : " is-off"}`}
			data-out={out.id}
			data-item={item.id}
		>
			<span
				className={`tally${playing ? " is-live" : ""}`}
				title={playing ? t("On air") : undefined}
				aria-hidden="true"
			/>
			<span className="tt-row__name truncate" title={name}>
				{name}
			</span>
			{!item.enabled ? <span className="tag">{t("API start is off")}</span> : null}
			<span className="hint">{playbackSummary(item, template)}</span>
			<span className="tt-row__move">
				<IconButton
					icon="up"
					label={t("Move up")}
					disabled={index === 0}
					onClick={() => moveItem(out.id, item.id, -1)}
				/>
				<IconButton
					icon="down"
					label={t("Move down")}
					disabled={index >= count - 1}
					onClick={() => moveItem(out.id, item.id, 1)}
				/>
			</span>
			<Menu items={menu} label={t("Actions: {name}", { name })} />
		</div>
	);
}

function OutCard({ out }: { out: Out }) {
	const templates = useTemplates();
	const runtime = useRuntime();
	const url = useOutUrl(out.id);
	const admin = useIsAdmin();
	const playing = runtime.playing?.[out.id] ?? [];
	const items = [...out.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

	const outMenu: MenuItem[] = [
		{
			label: t("Delete out"),
			icon: "trash",
			danger: true,
			onSelect: () => {
				if (window.confirm(
						t("Delete the out “{name}”? Its address in OBS will stop working.", { name: out.name }),
					)) {
					deleteOut(out.id);
				}
			},
		},
	];

	return (
		<section className="panel tt-out" data-out={out.id}>
			<header className="panel__head">
				<NameInput
					className="tt-out__name grow"
					label={t("Out name")}
					value={out.name}
					onCommit={(name) => saveOut({ ...clone(out), name })}
				/>
				<SizeInput
					label={t("Width, px")}
					value={out.width}
					onCommit={(width) => saveOut({ ...clone(out), width })}
				/>
				<span className="muted">×</span>
				<SizeInput
					label={t("Height, px")}
					value={out.height}
					onCommit={(height) => saveOut({ ...clone(out), height })}
				/>
				{admin ? <Menu items={outMenu} label={t("Actions: {name}", { name: out.name })} /> : null}
			</header>

			<div className="tt-url">
				<input
					readOnly
					className="mono"
					aria-label={t("Address for the Browser Source in OBS")}
					title={t("Address for the Browser Source in OBS")}
					value={url}
					onFocus={(event) => event.target.select()}
				/>
				<CopyButton text={url} label={t("Copy")} className="small" />
			</div>

			<NdiRow out={out} />

			{items.length === 0 ? (
				<div className="empty tt-out__empty">
					{t("Nothing here yet. Add an animation — it appears in Control and on the canvas in Editor.")}
				</div>
			) : (
				items.map((item, index) => (
					<PlacementRow
						key={item.id}
						out={out}
						item={item}
						index={index}
						count={items.length}
						playing={playing.includes(item.id)}
					/>
				))
			)}

			<div className="tt-out__foot">
				<Menu
					className="ghost"
					label={t("Add an animation to {name}", { name: out.name })}
					items={templates.map((template) => ({
						label: template.name,
						hint: t(KIND_LABEL[template.kind]),
						onSelect: () => addItem(out.id, template.id),
					}))}
				>
					<Icon name="plus" size={14} />
					{t("Add animation")}
				</Menu>
			</div>
		</section>
	);
}

// ------------------------------------------------------------------ library

function LibraryRow({ template, outs }: { template: TitleTemplate; outs: Out[] }) {
	const bindings = collectBindingPaths(template);

	const menu: MenuItem[] = [
		{ label: t("Duplicate"), icon: "copy", onSelect: () => duplicateTemplate(template.id) },
		{
			label: t("Delete animation"),
			icon: "trash",
			danger: true,
			separated: true,
			onSelect: () => {
				if (window.confirm(t("Delete “{name}”? It disappears from every out.", { name: template.name }))) {
					deleteTemplate(template.id);
				}
			},
		},
	];

	return (
		<div className="tt-row tt-row--lib" data-template={template.id}>
			<div className="tt-lib__main">
				<NameInput
					label={t("Animation name")}
					value={template.name}
					onCommit={(name) => saveTemplate({ ...clone(template), name })}
				/>
				{bindings.length > 0 ? (
					<span
						className="hint truncate"
						title={t("Reads the variables: {list}", { list: bindings.join(", ") })}
					>
						{tr("reads {list}", { list: <span className="mono">{bindings.join(", ")}</span> })}
					</span>
				) : null}
			</div>
			<span className="tag">{t(KIND_LABEL[template.kind])}</span>
			{outs.length === 1 ? (
				<button
					type="button"
					className="ghost small"
					title={t("Place on {name}", { name: outs[0]!.name })}
					onClick={() => addItem(outs[0]!.id, template.id)}
				>
					{t("Place")}
				</button>
			) : outs.length > 1 ? (
				<Menu
					className="ghost small"
					label={t("Place on the out")}
					items={outs.map((out) => ({
						label: out.name,
						onSelect: () => addItem(out.id, template.id),
					}))}
				>
					{t("Place")}
					<Icon name="chevronDown" size={12} />
				</Menu>
			) : null}
			<Menu items={menu} label={t("Actions: {name}", { name: template.name })} />
		</div>
	);
}

function Library() {
	const templates = useTemplates();
	const outs = useOuts();

	const create: MenuItem[] = [
		{
			label: t("From layers"),
			hint: t("Text, shapes, images and video — built with the mouse in Editor"),
			icon: "layers",
			onSelect: () => saveTemplate({ ...newTemplate("layers"), name: t("New animation") }),
		},
		{
			label: t("From code"),
			hint: t("Your own HTML, CSS and JavaScript"),
			icon: "code",
			onSelect: () => saveTemplate({ ...newTemplate("code"), name: t("New code animation") }),
		},
		exampleMenuItem((example) => addExample(example, getLang())),
	];

	return (
		<div className="tt-col">
			<header className="tt-head">
				<h2>{t("Animations")}</h2>
				<span className="spacer" />
				<Menu items={create} label={t("New animation")}>
					<Icon name="plus" size={14} />
					{t("New animation")}
				</Menu>
				<ThemeSwitch />
				<LangSwitch />
			</header>
			<section className="panel tt-lib">
				{templates.length === 0 ? (
					<div className="empty">
						{t("No animations yet. Create your own or take a ready-made one: “New animation” → “From an example”.")}
					</div>
				) : (
					templates.map((template) => (
						<LibraryRow key={template.id} template={template} outs={outs} />
					))
				)}
			</section>
		</div>
	);
}

// ---------------------------------------------------------------------- app

function App() {
	const outs = useOuts();
	const admin = useIsAdmin();
	useLang();

	return (
		<div className="tt">
			<div className="tt-col">
				<header className="tt-head">
					<h2>Outs</h2>
					<span className="hint truncate">{t("One out is one Browser Source in OBS")}</span>
					<span className="spacer" />
					{admin ? (
						<button type="button" onClick={() => createOut(t("New out"))}>
							<Icon name="plus" size={14} />
							{t("New out")}
						</button>
					) : null}
				</header>
				{outs.length === 0 ? (
					<section className="panel">
						<div className="empty">
							{admin
								? t("No outs yet. Create the first one and paste its address into a Browser Source in OBS.")
								: t("No outs are shared with you yet. An administrator adds outs to your group in the Team panel.")}
						</div>
					</section>
				) : (
					outs.map((out) => <OutCard key={out.id} out={out} />)
				)}
				<NdiSenders outs={outs} />
			</div>
			<Library />
		</div>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
