import { useEffect, useState } from "react";

import {
	clone,
	coerce,
	deleteByPath,
	flattenData,
	getByPathRaw,
	setByPath,
} from "../shared/binding";
import { getNodecg, type ClientReplicant } from "../shared/client";
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

// ------------------------------------------------------------------ reading

export function listTemplates(): TitleTemplate[] {
	return getDb().templates.value ?? [];
}

export function getTemplate(id: string | null | undefined): TitleTemplate | undefined {
	if (!id) return undefined;
	return listTemplates().find((t) => t.id === id);
}

export function listOuts(): Out[] {
	return getDb().outs.value ?? [];
}

export function getOut(id: string | null | undefined): Out | undefined {
	if (!id) return undefined;
	return listOuts().find((o) => o.id === id);
}

export function readData(): TitleData {
	return getDb().titleData.value ?? {};
}

export function readActive(): ActiveTitleState {
	return (
		getDb().activeTitle.value ?? {
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
	getDb().templates.value = list;
	return next;
}

export function deleteTemplate(id: string): void {
	const d = getDb();
	d.templates.value = listTemplates().filter((t) => t.id !== id);
	d.outs.value = listOuts().map((out) => ({
		...out,
		items: out.items.filter((item) => item.templateId !== id),
	}));
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

export function saveOut(out: Out): Out {
	const next = { ...clone(out), updatedAt: Date.now() };
	const list = clone(listOuts());
	const index = list.findIndex((o) => o.id === next.id);
	if (index >= 0) list[index] = next;
	else list.push(next);
	getDb().outs.value = list;
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
	getDb().outs.value = listOuts().filter((o) => o.id !== id);
}

export function addItem(outId: string, templateId: string): OutItem | undefined {
	const out = getOut(outId);
	const template = getTemplate(templateId);
	if (!out || !template) return undefined;
	const item: OutItem = {
		id: newId("item"),
		templateId,
		x: 0,
		y: 0,
		scale: 1,
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
	getDb().titleData.value = next;
}

export function removeDataValue(path: string): void {
	const next = clone(readData());
	deleteByPath(next, path);
	getDb().titleData.value = next;
}

export function replaceData(data: TitleData): void {
	getDb().titleData.value = clone(data);
}

export function mergeData(data: TitleData): void {
	const next = clone(readData());
	for (const row of flattenData(data)) setByPath(next, row.path, row.value);
	getDb().titleData.value = next;
}

// ------------------------------------------------------------------ titles

export function showTitle(
	templateId: string,
	opts: { outId?: string | null; data?: TitleData; label?: string } = {},
): void {
	getDb().activeTitle.value = {
		templateId,
		visible: true,
		outId: opts.outId ?? null,
		data: opts.data ?? {},
		label: opts.label,
		updatedAt: Date.now(),
	};
}

export function hideTitle(opts: { outId?: string | null } = {}): void {
	const current = readActive();
	getDb().activeTitle.value = {
		...current,
		visible: false,
		updatedAt: Date.now(),
		outId: opts.outId === undefined ? current.outId : opts.outId,
	};
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

export function triggerTemplate(templateId: string, outId?: string | null): void {
	void getNodecg().sendMessage(MESSAGES.trigger, { templateId, outId: outId ?? null });
}

// ---------------------------------------------------------------- selection

export function readSelection(): VariableSelection {
	return getDb().selection.value ?? {};
}

/**
 * Chooses which element of an array-valued variable is "the current" one.
 * Ignored for paths that are not collections, so a stray click cannot leave a
 * meaningless entry behind.
 */
export function setSelection(path: string, index: number): void {
	if (!Array.isArray(getByPathRaw(readData(), path))) return;
	getDb().selection.value = { ...readSelection(), [path]: Math.max(0, Math.floor(index)) };
}

export function clearSelection(path: string): void {
	const next = { ...readSelection() };
	delete next[path];
	getDb().selection.value = next;
}

/** The stored array at `path` (never auto-indexed). */
export function readArray(path: string): unknown[] {
	const raw = getByPathRaw(readData(), path);
	return Array.isArray(raw) ? raw : [];
}

function writeArray(path: string, list: unknown[]): void {
	const next = clone(readData());
	setByPath(next, path, list);
	getDb().titleData.value = next;
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
