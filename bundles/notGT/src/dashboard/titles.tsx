/**
 * notGT — Titles & Outs dashboard panel (fullbleed): setup only.
 *
 * Left: the outs — name, size, the OBS address and which animations sit on
 * each. Right: the animation library. Where a placement sits and how it plays
 * is edited where it can be seen: on the canvas in the Editor, and next to the
 * on-air switch in Control.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import { collectBindingPaths } from "../shared/binding";
import type { Out, OutItem, TitleTemplate } from "../shared/types";
import { N_, getLang, t, tr, useLang, type Phrase } from "./i18n";
import {
	absoluteOutUrl,
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
	const url = absoluteOutUrl(out.id);
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
				<Menu items={outMenu} label={t("Actions: {name}", { name: out.name })} />
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
	useLang();

	return (
		<div className="tt">
			<div className="tt-col">
				<header className="tt-head">
					<h2>Outs</h2>
					<span className="hint truncate">{t("One out is one Browser Source in OBS")}</span>
					<span className="spacer" />
					<button type="button" onClick={() => createOut(t("New out"))}>
						<Icon name="plus" size={14} />
						{t("New out")}
					</button>
				</header>
				{outs.length === 0 ? (
					<section className="panel">
						<div className="empty">
							{t("No outs yet. Create the first one and paste its address into a Browser Source in OBS.")}
						</div>
					</section>
				) : (
					outs.map((out) => <OutCard key={out.id} out={out} />)
				)}
			</div>
			<Library />
		</div>
	);
}

const container = document.getElementById("notgt-root");
if (container) createRoot(container).render(<App />);
