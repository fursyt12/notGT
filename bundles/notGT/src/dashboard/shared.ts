import { useEffect, useState } from "react";

import {
	clone,
	coerce,
	deleteByPath,
	flattenData,
	getByPathRaw,
	setByPath,
} from "../shared/binding";
import { localNumber, t } from "./i18n";
import { getNodecg, type ClientReplicant } from "../shared/client";
import type { ExampleLang, GalleryExample } from "../shared/examples/gallery";
import {
	createDefaultOut,
	createDefaultTemplate,
	createCodeSampleTemplate,
	outUrl,
} from "../shared/defaults";
import {
	BUNDLE_NAME,
	MESSAGES,
	type ActiveTitleState,
	type Out,
	type OutItem,
	type PlaybackConfig,
	REPLICANTS,
	type RuntimeState,
	type TitleData,
	type TitleTemplate,
	type VariableSelection,
	defaultPlayback,
	defaultTransition,
	newId,
	slugify,
} from "../shared/types";

export type { ClientReplicant };

export interface Db {
	templates: ClientReplicant<TitleTemplate[]>;
	outs: ClientReplicant<Out[]>;
	titleData: ClientReplicant<TitleData>;
	activeTitle: ClientReplicant<ActiveTitleState>;
	runtime: ClientReplicant<RuntimeState>;
	selection: ClientReplicant<VariableSelection>;
}

let db: Db | undefined;

export function getDb(): Db {
	if (db) return db;
	const nodecg = getNodecg();
	db = {
		templates: nodecg.Replicant<TitleTemplate[]>(
			REPLICANTS.templates,
			BUNDLE_NAME,
			{ defaultValue: [] },
		) as ClientReplicant<TitleTemplate[]>,
		outs: nodecg.Replicant<Out[]>(REPLICANTS.outs, BUNDLE_NAME, {
			defaultValue: [],
		}) as ClientReplicant<Out[]>,
		titleData: nodecg.Replicant<TitleData>(
			REPLICANTS.titleData,
			BUNDLE_NAME,
			{ defaultValue: {} },
		) as ClientReplicant<TitleData>,
		activeTitle: nodecg.Replicant<ActiveTitleState>(
			REPLICANTS.activeTitle,
			BUNDLE_NAME,
			{
				defaultValue: {
					templateId: null,
					visible: false,
					outId: null,
					data: {},
					updatedAt: 0,
				},
			},
		) as ClientReplicant<ActiveTitleState>,
		runtime: nodecg.Replicant<RuntimeState>(
			REPLICANTS.runtime,
			BUNDLE_NAME,
			{ defaultValue: { playing: {}, triggers: {}, revision: 0 } },
		) as ClientReplicant<RuntimeState>,
		selection: nodecg.Replicant<VariableSelection>(
			REPLICANTS.selection,
			BUNDLE_NAME,
			{ defaultValue: {} },
		) as ClientReplicant<VariableSelection>,
	};
	return db;
}

// ----------------------------------------------------- read-your-writes store

/**
 * NodeCG applies a browser-side write only when the server echoes it back, so
 * `rep.value` read straight after `rep.value = x` still returns the old value —
 * and a second write built from that read silently drops the first. Placing an
 * animation right after creating it, or switching two outs off in one go, are
 * exactly that.
 *
 * `pending` keeps what was written until the echo arrives, so every helper
 * below reads its own writes. All reads and writes of the editable Replicants
 * go through `read` / `write`.
 */
const pending = new Map<object, { value: unknown; expires: number }>();

/** How long an unconfirmed write is trusted over the Replicant's own value. */
const PENDING_MS = 2000;

function read<T>(rep: ClientReplicant<T>): T | undefined {
	const entry = pending.get(rep);
	if (!entry) return rep.value;
	// A write the server never echoed as written (rejected or normalised) must
	// not hide the real value for good.
	if (Date.now() > entry.expires) {
		pending.delete(rep);
		return rep.value;
	}
	return entry.value as T;
}

const watched = new WeakSet<object>();

function write<T>(rep: ClientReplicant<T>, value: T): void {
	if (!watched.has(rep)) {
		watched.add(rep);
		// The echo of the last write of a tick carries the same value: from
		// then on the Replicant itself is current again.
		rep.on("change", (next: unknown) => {
			const entry = pending.get(rep);
			if (entry && JSON.stringify(next) === JSON.stringify(entry.value)) pending.delete(rep);
		});
	}
	pending.set(rep, { value, expires: Date.now() + PENDING_MS });
	rep.value = value;
}

// ------------------------------------------------------------------ reading

export function listTemplates(): TitleTemplate[] {
	return read(getDb().templates) ?? [];
}

export function getTemplate(id: string | null | undefined): TitleTemplate | undefined {
	if (!id) return undefined;
	return listTemplates().find((t) => t.id === id);
}

export function listOuts(): Out[] {
	return read(getDb().outs) ?? [];
}

export function getOut(id: string | null | undefined): Out | undefined {
	if (!id) return undefined;
	return listOuts().find((o) => o.id === id);
}

export function readData(): TitleData {
	return read(getDb().titleData) ?? {};
}

export function readActive(): ActiveTitleState {
	return (
		read(getDb().activeTitle) ?? {
			templateId: null,
			visible: false,
			outId: null,
			data: {},
			updatedAt: 0,
		}
	);
}

export function readRuntime(): RuntimeState {
	return getDb().runtime.value ?? { playing: {}, triggers: {}, revision: 0 };
}

// ------------------------------------------------------------------ writing

export function saveTemplate(template: TitleTemplate): TitleTemplate {
	const next = { ...clone(template), updatedAt: Date.now() };
	const list = clone(listTemplates());
	const index = list.findIndex((t) => t.id === next.id);
	if (index >= 0) list[index] = next;
	else list.push(next);
	write(getDb().templates, list);
	return next;
}

export function deleteTemplate(id: string): void {
	const d = getDb();
	write(d.templates, listTemplates().filter((t) => t.id !== id));
	write(d.outs, listOuts().map((out) => ({
		...out,
		items: out.items.filter((item) => item.templateId !== id),
	})));
}

export function newTemplate(kind: TitleTemplate["kind"] = "layers"): TitleTemplate {
	const base = kind === "code" ? createCodeSampleTemplate() : createDefaultTemplate();
	return {
		...base,
		id: newId("tpl"),
		name: kind === "code" ? "New code animation" : "New animation",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

/**
 * Adds an example to the library as an ordinary animation, in `lang`. Sample
 * values are added only for the variables that do not exist yet, so the
 * operator's own data is never replaced.
 */
export function addExample(example: GalleryExample, lang: ExampleLang): TitleTemplate {
	const now = Date.now();
	const saved = saveTemplate({
		...example.template(lang),
		id: newId("tpl"),
		name: example.name[lang],
		createdAt: now,
		updatedAt: now,
	});

	const sample = example.data?.(lang);
	if (sample) {
		const current = readData();
		const next = clone(current);
		let changed = false;
		for (const row of flattenData(sample)) {
			if (getByPathRaw(current, row.path) !== undefined) continue;
			setByPath(next, row.path, row.value);
			changed = true;
		}
		if (changed) write(getDb().titleData, next);
	}
	return saved;
}

export function duplicateTemplate(id: string): TitleTemplate | undefined {
	const source = getTemplate(id);
	if (!source) return undefined;
	const copy = clone(source);
	copy.id = newId("tpl");
	copy.name = `${source.name} copy`;
	copy.layers = copy.layers.map((layer) => ({ ...layer, id: newId("layer") }));
	copy.createdAt = Date.now();
	copy.updatedAt = Date.now();
	saveTemplate(copy);
	return copy;
}

/**
 * Effective playback of a placement: its own settings override the template's,
 * exactly the way the scheduler resolves them.
 */
export function effectivePlayback(
	item: OutItem,
	template: TitleTemplate | undefined,
): PlaybackConfig {
	return { ...(template?.playback ?? defaultPlayback()), ...(item.playback ?? {}) };
}

/**
 * Can this placement be played on demand with "проиграть"?
 *
 * Loops and held placements cannot: the scheduler only toggles them on and off
 * (a held placement never times out, and a loop plays on its interval), so the
 * button would do nothing. They are switched in the Control panel instead.
 */
export function itemCanPlay(item: OutItem, template: TitleTemplate | undefined): boolean {
	if (item.held) return false;
	return effectivePlayback(item, template).mode !== "loop";
}

export function saveOut(out: Out): Out {
	const next = { ...clone(out), updatedAt: Date.now() };
	const list = clone(listOuts());
	const index = list.findIndex((o) => o.id === next.id);
	if (index >= 0) list[index] = next;
	else list.push(next);
	write(getDb().outs, list);
	return next;
}

export function createOut(name = "New out"): Out {
	const base = createDefaultOut(slugify(name, "out"));
	// Guarantee a unique id.
	let id = base.id;
	let counter = 2;
	while (getOut(id)) id = `${base.id}-${counter++}`;
	const out: Out = { ...base, id, name, createdAt: Date.now(), updatedAt: Date.now() };
	saveOut(out);
	return out;
}

export function deleteOut(id: string): void {
	write(getDb().outs, listOuts().filter((o) => o.id !== id));
}

/**
 * Places an animation on an out. `patch` sets where it sits in the same write:
 * a second write to the out straight after this one would be built from the
 * list as it was before the placement existed, and would drop it.
 */
export function addItem(
	outId: string,
	templateId: string,
	patch: Partial<Pick<OutItem, "x" | "y" | "scale">> = {},
): OutItem | undefined {
	const out = getOut(outId);
	const template = getTemplate(templateId);
	if (!out || !template) return undefined;
	const item: OutItem = {
		id: newId("item"),
		templateId,
		x: 0,
		y: 0,
		scale: 1,
		...patch,
		playback: { ...defaultPlayback(), ...template.playback },
		enabled: true,
		order: out.items.length,
	};
	saveOut({ ...out, items: [...out.items, item] });
	return item;
}

export function updateItem(
	outId: string,
	itemId: string,
	patch: Partial<OutItem>,
): void {
	const out = getOut(outId);
	if (!out) return;
	saveOut({
		...out,
		items: out.items.map((item) =>
			item.id === itemId ? { ...item, ...patch } : item,
		),
	});
}

export function updateItemPlayback(
	outId: string,
	itemId: string,
	patch: Partial<PlaybackConfig>,
): void {
	const out = getOut(outId);
	const item = out?.items.find((i) => i.id === itemId);
	if (!out || !item) return;
	updateItem(outId, itemId, { playback: { ...item.playback, ...patch } });
}

export function removeItem(outId: string, itemId: string): void {
	const out = getOut(outId);
	if (!out) return;
	saveOut({ ...out, items: out.items.filter((i) => i.id !== itemId) });
}

export function moveItem(outId: string, itemId: string, delta: number): void {
	const out = getOut(outId);
	if (!out) return;
	const items = [...out.items].sort((a, b) => a.order - b.order);
	const index = items.findIndex((i) => i.id === itemId);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= items.length) return;
	const [moved] = items.splice(index, 1);
	items.splice(target, 0, moved!);
	saveOut({ ...out, items: items.map((item, i) => ({ ...item, order: i })) });
}

export function setDataValue(path: string, value: unknown): void {
	const next = clone(readData());
	setByPath(next, path, value);
	write(getDb().titleData, next);
}

export function removeDataValue(path: string): void {
	const next = clone(readData());
	deleteByPath(next, path);
	write(getDb().titleData, next);
}

export function replaceData(data: TitleData): void {
	write(getDb().titleData, clone(data));
}

export function mergeData(data: TitleData): void {
	const next = clone(readData());
	for (const row of flattenData(data)) setByPath(next, row.path, row.value);
	write(getDb().titleData, next);
}

// ------------------------------------------------------------------ titles

export function showTitle(
	templateId: string,
	opts: { outId?: string | null; data?: TitleData; label?: string } = {},
): void {
	write(getDb().activeTitle, {
		templateId,
		visible: true,
		outId: opts.outId ?? null,
		data: opts.data ?? {},
		label: opts.label,
		updatedAt: Date.now(),
	});
}

export function hideTitle(opts: { outId?: string | null } = {}): void {
	const current = readActive();
	write(getDb().activeTitle, {
		...current,
		visible: false,
		updatedAt: Date.now(),
		outId: opts.outId === undefined ? current.outId : opts.outId,
	});
}

export function toggleTitle(
	templateId: string,
	opts: { outId?: string | null; data?: TitleData } = {},
): void {
	const current = readActive();
	if (current.templateId === templateId && current.visible) hideTitle();
	else showTitle(templateId, opts);
}

export function triggerItem(outId: string, itemId: string, holdMs?: number): void {
	void getNodecg().sendMessage(MESSAGES.trigger, { outId, itemId, holdMs });
}

/** Takes everything off air right now, one-shots in flight included. */
export function stopPlayback(outId?: string | null): void {
	void getNodecg().sendMessage(MESSAGES.stop, { outId: outId ?? null });
}

export function triggerTemplate(templateId: string, outId?: string | null): void {
	void getNodecg().sendMessage(MESSAGES.trigger, { templateId, outId: outId ?? null });
}

// ---------------------------------------------------------------- selection

export function readSelection(): VariableSelection {
	return read(getDb().selection) ?? {};
}

/**
 * Chooses which element of an array-valued variable is "the current" one.
 * Ignored for paths that are not collections, so a stray click cannot leave a
 * meaningless entry behind.
 */
export function setSelection(path: string, index: number): void {
	if (!Array.isArray(getByPathRaw(readData(), path))) return;
	write(getDb().selection, { ...readSelection(), [path]: Math.max(0, Math.floor(index)) });
}

export function clearSelection(path: string): void {
	const next = { ...readSelection() };
	delete next[path];
	write(getDb().selection, next);
}

/** The stored array at `path` (never auto-indexed). */
export function readArray(path: string): unknown[] {
	const raw = getByPathRaw(readData(), path);
	return Array.isArray(raw) ? raw : [];
}

function writeArray(path: string, list: unknown[]): void {
	const next = clone(readData());
	setByPath(next, path, list);
	write(getDb().titleData, next);
	// Keep the chosen index inside the new bounds.
	const current = readSelection()[path];
	if (current !== undefined) {
		if (list.length === 0) clearSelection(path);
		else if (current > list.length - 1) setSelection(path, list.length - 1);
	}
}

export function setArrayItem(path: string, index: number, value: unknown): void {
	const list = [...readArray(path)];
	if (index < 0 || index >= list.length) return;
	list[index] = value;
	writeArray(path, list);
}

/** Appends a value; defaults to a copy of the last element (or an empty object). */
export function appendArrayItem(path: string, value?: unknown): number {
	const list = [...readArray(path)];
	const last = list[list.length - 1];
	const next =
		value !== undefined
			? value
			: last !== undefined && last !== null && typeof last === "object"
				? clone(last)
				: "";
	list.push(next);
	writeArray(path, list);
	return list.length - 1;
}

export function duplicateArrayItem(path: string, index: number): void {
	const list = [...readArray(path)];
	if (index < 0 || index >= list.length) return;
	list.splice(index + 1, 0, clone(list[index]));
	writeArray(path, list);
}

export function removeArrayItem(path: string, index: number): void {
	const list = [...readArray(path)];
	if (index < 0 || index >= list.length) return;
	list.splice(index, 1);
	writeArray(path, list);
}

export function moveArrayItem(path: string, index: number, delta: number): void {
	const list = [...readArray(path)];
	const target = index + delta;
	if (index < 0 || index >= list.length || target < 0 || target >= list.length) return;
	const [moved] = list.splice(index, 1);
	list.splice(target, 0, moved);
	writeArray(path, list);
	if (readSelection()[path] === index) setSelection(path, target);
	else if (readSelection()[path] === target) setSelection(path, index);
}

/** Creates an array variable from a scalar (or from nothing). */
export function makeArray(path: string, seed: unknown = {}): void {
	if (readArray(path).length > 0) return;
	const existing = getByPathRaw(readData(), path);
	writeArray(path, [existing !== undefined ? existing : seed]);
	setSelection(path, 0);
}

// -------------------------------------------------------------------- hooks

export function useReplicantValue<T>(
	selector: () => ClientReplicant<T>,
	fallback: T,
): T {
	const rep = selector();
	const [value, setValue] = useState<T>(() =>
		rep.status === "declared" && rep.value !== undefined ? rep.value : fallback,
	);

	useEffect(() => {
		const onChange = (next: T) => setValue(next === undefined ? fallback : next);
		const anyRep = rep as unknown as {
			on(ev: string, cb: (v: T) => void): void;
			off?(ev: string, cb: (v: T) => void): void;
			removeListener?(ev: string, cb: (v: T) => void): void;
		};
		anyRep.on("change", onChange);
		if (rep.status === "declared" && rep.value !== undefined) setValue(rep.value);
		return () => {
			if (typeof anyRep.off === "function") anyRep.off("change", onChange);
			else if (typeof anyRep.removeListener === "function") {
				anyRep.removeListener("change", onChange);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rep]);

	return value;
}

const EMPTY_TEMPLATES: TitleTemplate[] = [];
const EMPTY_OUTS: Out[] = [];
const EMPTY_DATA: TitleData = {};
const EMPTY_ACTIVE: ActiveTitleState = {
	templateId: null,
	visible: false,
	outId: null,
	data: {},
	updatedAt: 0,
};
const EMPTY_RUNTIME: RuntimeState = { playing: {}, triggers: {}, revision: 0 };
const EMPTY_SELECTION: VariableSelection = {};

export function useTemplates(): TitleTemplate[] {
	return useReplicantValue(() => getDb().templates, EMPTY_TEMPLATES);
}
export function useOuts(): Out[] {
	return useReplicantValue(() => getDb().outs, EMPTY_OUTS);
}
export function useTitleData(): TitleData {
	return useReplicantValue(() => getDb().titleData, EMPTY_DATA);
}
export function useActiveTitle(): ActiveTitleState {
	return useReplicantValue(() => getDb().activeTitle, EMPTY_ACTIVE);
}
export function useRuntime(): RuntimeState {
	return useReplicantValue(() => getDb().runtime, EMPTY_RUNTIME);
}
export function useSelection(): VariableSelection {
	return useReplicantValue(() => getDb().selection, EMPTY_SELECTION);
}

/** Re-renders the caller whenever any notGT replicant changes. */
export function useNotGtVersion(): number {
	const templates = useTemplates();
	const outs = useOuts();
	const data = useTitleData();
	const active = useActiveTitle();
	const runtime = useRuntime();
	return (
		templates.length +
		outs.length +
		Object.keys(data).length +
		(active.updatedAt ?? 0) +
		(runtime.revision ?? 0)
	);
}

// --------------------------------------------------------------- video hold

/**
 * `src` of a template's first video layer, or `""` when it has none. Used both
 * as the `hasVideoLayer` test and as a cache signature so that editing the clip
 * of a template re-probes instead of reusing a stale duration.
 */
export function videoLayerSignature(template: TitleTemplate | undefined | null): string {
	if (!template || template.kind === "code") return "";
	const layer = (template.layers ?? []).find((item) => item.type === "video" && item.src);
	return layer?.src ?? "";
}

export function hasVideoLayer(template: TitleTemplate | undefined | null): boolean {
	return videoLayerSignature(template) !== "";
}

interface VideoDurationEntry {
	signature: string;
	value: number | null;
}

const videoDurationCache = new Map<string, VideoDurationEntry>();
const videoDurationInflight = new Map<string, Promise<number | null>>();

/**
 * Length (ms) of the template's first local video layer, via the server's
 * ffprobe endpoint. `null` means "not determinable" (no video layer, http/data
 * URI, `{{...}}` binding, missing file, no ffprobe, network failure). Results
 * are cached per template + video src; simultaneous callers share one request.
 */
export function probeVideoDuration(templateId: string, signature = ""): Promise<number | null> {
	const cached = videoDurationCache.get(templateId);
	if (cached && cached.signature === signature) return Promise.resolve(cached.value);
	const running = videoDurationInflight.get(templateId);
	if (running) return running;

	const request = (async (): Promise<number | null> => {
		try {
			const response = await fetch(
				`/api/media/probe?templateId=${encodeURIComponent(templateId)}`,
				{ headers: { accept: "application/json" } },
			);
			if (!response.ok) return null;
			const payload = (await response.json()) as { durationMs?: unknown };
			const raw = payload?.durationMs;
			const value =
				typeof raw === "number" && Number.isFinite(raw) && raw > 0
					? Math.round(raw)
					: null;
			videoDurationCache.set(templateId, { signature, value });
			return value;
		} catch {
			// A failed probe is treated as "unknown" but deliberately not cached,
			// so a transient network hiccup is retried on the next toggle.
			return null;
		} finally {
			videoDurationInflight.delete(templateId);
		}
	})();

	videoDurationInflight.set(templateId, request);
	return request;
}

/**
 * The probed video length for `templateId`, or `undefined` while unknown /
 * disabled. The request only fires when `enabled` is true (the operator chose
 * `holdMode: "video"`), so typing in the `holdMs` field never probes.
 */
export function useVideoDuration(
	templateId: string | undefined,
	enabled: boolean,
	signature = "",
): number | null | undefined {
	const key = enabled && templateId ? `${templateId}\u0000${signature}` : "";
	const [state, setState] = useState<{ key: string; value: number | null | undefined }>({
		key: "",
		value: undefined,
	});

	useEffect(() => {
		if (!enabled || !templateId) {
			setState((previous) => (previous.key === "" ? previous : { key: "", value: undefined }));
			return;
		}
		const cached = videoDurationCache.get(templateId);
		if (cached && cached.signature === signature) {
			setState((previous) =>
				previous.key === key ? previous : { key, value: cached.value },
			);
			return;
		}
		let alive = true;
		setState((previous) => (previous.key === key ? previous : { key, value: undefined }));
		void probeVideoDuration(templateId, signature).then((value) => {
			if (alive) setState({ key, value });
		});
		return () => {
			alive = false;
		};
	}, [key, enabled, templateId, signature]);

	return state.key === key && key !== "" ? state.value : undefined;
}

/** Text rendered next to the «длительность = видео» checkbox. */
export function videoHoldHint(
	duration: number | null | undefined,
	hasVideo: boolean,
): string {
	if (typeof duration === "number" && duration > 0) {
		return t("({n} s)", { n: localNumber((duration / 1000).toFixed(1)) });
	}
	if (!hasVideo) return t("(the animation has no video layer — “Hold” is used)");
	return t("(the video length is unknown — “Hold” is used)");
}

// -------------------------------------------------------------------- utils

export function outUrlFor(outId: string): string {
	return outUrl(outId);
}

export function absoluteOutUrl(outId: string): string {
	return `${window.location.origin}${outUrl(outId)}`;
}

export function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	const area = document.createElement("textarea");
	area.value = text;
	document.body.appendChild(area);
	area.select();
	document.execCommand("copy");
	area.remove();
	return Promise.resolve();
}

export function formatMs(ms: number | undefined): string {
	if (!ms || ms < 1000) return `${ms ?? 0} ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export { clone, coerce, flattenData, setByPath, deleteByPath, defaultTransition, defaultPlayback, newId, slugify, outUrl };
