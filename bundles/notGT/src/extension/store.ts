import type NodeCGTypes from "nodecg/types";

import {
	clone,
	deleteByPath,
	getByPath,
	setByPath,
} from "../shared/binding";
import {
	createDefaultOut,
	outUrl,
	seedData,
	seedTemplates,
} from "../shared/defaults";
import {
	BUNDLE_NAME,
	type ActiveTitleState,
	type MetaState,
	type Out,
	type OutItem,
	REPLICANTS,
	type RuntimeState,
	type TitleData,
	type TitleTemplate,
	type VariableSelection,
} from "../shared/types";
export interface BundleConfig {
	apiToken?: string;
	allowUnauthenticatedApi?: boolean;
	hideApiState?: boolean;
	defaultOutId?: string;
	/** Where uploaded/converted media is stored. Default: <runtimeRoot>/assets/notGT/media */
	mediaDir?: string;
}

export type ServerAPI = NodeCGTypes.ServerAPI<BundleConfig>;

type Rep<T> = NodeCGTypes.ServerReplicant<T>;

export interface Store {
	readonly nodecg: ServerAPI;
	readonly templates: Rep<TitleTemplate[]>;
	readonly outs: Rep<Out[]>;
	readonly titleData: Rep<TitleData>;
	readonly activeTitle: Rep<ActiveTitleState>;
	readonly runtime: Rep<RuntimeState>;
	readonly selection: Rep<VariableSelection>;
	readonly meta: Rep<MetaState>;

	listTemplates(): TitleTemplate[];
	getTemplate(id: string): TitleTemplate | undefined;
	upsertTemplate(template: TitleTemplate): TitleTemplate;
	patchTemplate(id: string, patch: Partial<TitleTemplate>): TitleTemplate | undefined;
	removeTemplate(id: string): boolean;

	listOuts(): Out[];
	getOut(id: string): Out | undefined;
	upsertOut(out: Out): Out;
	patchOut(id: string, patch: Partial<Out>): Out | undefined;
	removeOut(id: string): boolean;

	getItem(outId: string, itemId: string): { out: Out; item: OutItem } | undefined;
	addPlaying(outId: string, itemId: string): void;
	removePlaying(outId: string, itemId: string): void;
	/** Bumps the play counter so graphics restart the entrance animation. */
	markTrigger(outId: string, itemId: string): void;
	triggerCount(outId: string, itemId: string): number;
	isPlaying(outId: string, itemId: string): boolean;
	playingFor(outId: string): string[];

	readData(): TitleData;
	setData(patch: TitleData, mode: "merge" | "replace"): TitleData;
	deleteData(path: string): TitleData;
	readPath(path: string): unknown;

	readSelection(): VariableSelection;
	setSelection(patch: VariableSelection): VariableSelection;
	clearSelection(path: string): VariableSelection;

	show(
		templateId: string,
		opts?: { outId?: string | null; data?: TitleData; label?: string },
	): ActiveTitleState | undefined;
	hide(opts?: { outId?: string | null; templateId?: string }): ActiveTitleState;
	/** Clears the manual program state entirely (templateId, overrides, visibility). */
	resetActive(): ActiveTitleState;
	toggle(
		templateId: string,
		opts?: { outId?: string | null; data?: TitleData; label?: string },
	): ActiveTitleState | undefined;

	/** Merged variable store: global data + active-title override. */
	effectiveData(): TitleData;

	outUrl(outId: string): string;
}

const DEFAULT_ACTIVE: ActiveTitleState = {
	templateId: null,
	visible: false,
	outId: null,
	data: {},
	updatedAt: 0,
};

export function createStore(nodecg: ServerAPI): Store {
	const log = nodecg.log;

	const templates = nodecg.Replicant<TitleTemplate[]>(
		REPLICANTS.templates,
		BUNDLE_NAME,
		{ defaultValue: [], persistent: true },
	);
	const outs = nodecg.Replicant<Out[]>(REPLICANTS.outs, BUNDLE_NAME, {
		defaultValue: [],
		persistent: true,
	});
	const titleData = nodecg.Replicant<TitleData>(
		REPLICANTS.titleData,
		BUNDLE_NAME,
		{ defaultValue: {}, persistent: true },
	);
	const activeTitle = nodecg.Replicant<ActiveTitleState>(
		REPLICANTS.activeTitle,
		BUNDLE_NAME,
		{ defaultValue: { ...DEFAULT_ACTIVE }, persistent: true },
	);
	const runtime = nodecg.Replicant<RuntimeState>(REPLICANTS.runtime, BUNDLE_NAME, {
		defaultValue: { playing: {}, triggers: {}, revision: 0 },
		persistent: false,
	});
	const selection = nodecg.Replicant<VariableSelection>(
		REPLICANTS.selection,
		BUNDLE_NAME,
		{ defaultValue: {}, persistent: true },
	);
	const meta = nodecg.Replicant<MetaState>(REPLICANTS.meta, BUNDLE_NAME, {
		defaultValue: { initialized: false, schemaVersion: 1 },
		persistent: true,
	});

	function listTemplates(): TitleTemplate[] {
		return templates.value ?? [];
	}
	function getTemplate(id: string): TitleTemplate | undefined {
		return listTemplates().find((t) => t.id === id);
	}
	function upsertTemplate(template: TitleTemplate): TitleTemplate {
		const next = clone(template);
		next.updatedAt = Date.now();
		const list = clone(listTemplates());
		const idx = list.findIndex((t) => t.id === next.id);
		if (idx >= 0) list[idx] = next;
		else list.push(next);
		templates.value = list;
		return next;
	}
	function patchTemplate(
		id: string,
		patch: Partial<TitleTemplate>,
	): TitleTemplate | undefined {
		const existing = getTemplate(id);
		if (!existing) return undefined;
		return upsertTemplate({ ...existing, ...patch, id, updatedAt: Date.now() });
	}
	function removeTemplate(id: string): boolean {
		const list = listTemplates();
		if (!list.some((t) => t.id === id)) return false;
		templates.value = list.filter((t) => t.id !== id);
		// Drop the orphaned placements, otherwise outs keep ghost animations.
		outs.value = (outs.value ?? []).map((o: Out) => ({
			...o,
			items: o.items.filter((i: OutItem) => i.templateId !== id),
		}));
		if (activeTitle.value?.templateId === id) {
			// Drop the reference entirely: leaving the deleted id behind would
			// leave the program state pointing at a template that no longer exists.
			activeTitle.value = { ...DEFAULT_ACTIVE, updatedAt: Date.now() };
		}
		return true;
	}

	function listOuts(): Out[] {
		return outs.value ?? [];
	}
	function getOut(id: string): Out | undefined {
		return listOuts().find((o) => o.id === id);
	}
	function upsertOut(out: Out): Out {
		const next = clone(out);
		next.updatedAt = Date.now();
		const list = clone(listOuts());
		const idx = list.findIndex((o) => o.id === next.id);
		if (idx >= 0) list[idx] = next;
		else list.push(next);
		outs.value = list;
		return next;
	}
	function patchOut(id: string, patch: Partial<Out>): Out | undefined {
		const existing = getOut(id);
		if (!existing) return undefined;
		return upsertOut({ ...existing, ...patch, id });
	}
	function removeOut(id: string): boolean {
		if (!getOut(id)) return false;
		outs.value = listOuts().filter((o) => o.id !== id);
		const playing = { ...(runtime.value?.playing ?? {}) };
		delete playing[id];
		writeRuntime({ playing });
		return true;
	}

	function getItem(
		outId: string,
		itemId: string,
	): { out: Out; item: OutItem } | undefined {
		const out = getOut(outId);
		if (!out) return undefined;
		const item = out.items.find((i) => i.id === itemId);
		if (!item) return undefined;
		return { out, item };
	}

	function playingMap(): Record<string, string[]> {
		return { ...(runtime.value?.playing ?? {}) };
	}

	function triggerMap(): Record<string, number> {
		return { ...(runtime.value?.triggers ?? {}) };
	}

	function writeRuntime(next: {
		playing?: Record<string, string[]>;
		triggers?: Record<string, number>;
	}): void {
		runtime.value = {
			playing: next.playing ?? playingMap(),
			triggers: next.triggers ?? triggerMap(),
			revision: (runtime.value?.revision ?? 0) + 1,
		};
	}

	function setPlaying(outId: string, itemIds: string[]): void {
		const playing = playingMap();
		const unique = [...new Set(itemIds)];
		if (unique.length === 0) delete playing[outId];
		else playing[outId] = unique;
		writeRuntime({ playing });
	}

	/** Bumps the play counter so graphics restart the entrance animation. */
	function markTrigger(outId: string, itemId: string): void {
		const triggers = triggerMap();
		const key = `${outId}:${itemId}`;
		triggers[key] = (triggers[key] ?? 0) + 1;
		writeRuntime({ triggers });
	}

	function triggerCount(outId: string, itemId: string): number {
		return runtime.value?.triggers?.[`${outId}:${itemId}`] ?? 0;
	}

	function isPlaying(outId: string, itemId: string): boolean {
		return Boolean(runtime.value?.playing?.[outId]?.includes(itemId));
	}

	function playingFor(outId: string): string[] {
		return [...(runtime.value?.playing?.[outId] ?? [])];
	}

	function addPlaying(outId: string, itemId: string): void {
		const current = playingFor(outId);
		if (current.includes(itemId)) return;
		setPlaying(outId, [...current, itemId]);
	}

	function removePlaying(outId: string, itemId: string): void {
		const current = playingFor(outId);
		if (!current.includes(itemId)) return;
		setPlaying(
			outId,
			current.filter((id) => id !== itemId),
		);
	}

	function readData(): TitleData {
		return titleData.value ?? {};
	}
	function setData(patch: TitleData, mode: "merge" | "replace"): TitleData {
		if (mode === "replace") {
			titleData.value = clone(patch ?? {});
		} else {
			const next = clone(readData());
			for (const [path, value] of Object.entries(patch ?? {})) {
				// Support both nested objects and dotted keys from flat forms.
				if (value !== null && typeof value === "object" && !Array.isArray(value)) {
					for (const [k, v] of flattenEntries(value as Record<string, unknown>, path)) {
						setByPath(next, k, v);
					}
				} else {
					setByPath(next, path, value);
				}
			}
			titleData.value = next;
		}
		return titleData.value;
	}
	function deleteData(path: string): TitleData {
		const next = clone(readData());
		deleteByPath(next, path);
		titleData.value = next;
		return next;
	}
	function readPath(path: string): unknown {
		return getByPath(readData(), path, readSelection());
	}

	function readSelection(): VariableSelection {
		return selection.value ?? {};
	}
	function setSelection(patch: VariableSelection): VariableSelection {
		const next: VariableSelection = { ...readSelection() };
		for (const [path, index] of Object.entries(patch ?? {})) {
			const value = Number(index);
			if (Number.isFinite(value) && value >= 0) next[path] = Math.floor(value);
		}
		selection.value = next;
		return next;
	}
	function clearSelection(path: string): VariableSelection {
		const next: VariableSelection = { ...readSelection() };
		delete next[path];
		selection.value = next;
		return next;
	}

	function show(
		templateId: string,
		opts: { outId?: string | null; data?: TitleData; label?: string } = {},
	): ActiveTitleState | undefined {
		if (!getTemplate(templateId)) {
			log.warn("Ignoring show for unknown template %s", templateId);
			return undefined;
		}
		const state: ActiveTitleState = {
			templateId,
			visible: true,
			outId: opts.outId === undefined ? null : opts.outId,
			data: clone(opts.data ?? {}),
			label: opts.label,
			updatedAt: Date.now(),
		};
		activeTitle.value = state;
		return state;
	}

	function hide(opts: { outId?: string | null; templateId?: string } = {}): ActiveTitleState {
		const current = activeTitle.value ?? { ...DEFAULT_ACTIVE };
		if (opts.templateId && current.templateId !== opts.templateId) return current;
		if (opts.outId !== undefined && opts.outId !== null && current.outId !== opts.outId) {
			return current;
		}
		const next: ActiveTitleState = {
			...current,
			visible: false,
			updatedAt: Date.now(),
		};
		activeTitle.value = next;
		return next;
	}

	function resetActive(): ActiveTitleState {
		activeTitle.value = { ...DEFAULT_ACTIVE, updatedAt: Date.now() };
		return activeTitle.value;
	}

	function toggle(
		templateId: string,
		opts: { outId?: string | null; data?: TitleData; label?: string } = {},
	): ActiveTitleState | undefined {
		const current = activeTitle.value ?? DEFAULT_ACTIVE;
		if (current.templateId === templateId && current.visible) {
			return hide({ templateId, outId: opts.outId });
		}
		return show(templateId, opts);
	}

	function effectiveData(): TitleData {
		const merged = clone(readData());
		const override = activeTitle.value?.data ?? {};
		for (const [k, v] of flattenEntries(override)) setByPath(merged, k, v);
		return merged;
	}

	function outUrlFor(outId: string): string {
		return outUrl(outId);
	}

	// ---------------------------------------------------------------------
	// First-run seeding
	// ---------------------------------------------------------------------
	if (!meta.value?.initialized) {
		const defaultOutId = nodecg.bundleConfig?.defaultOutId || "main";
		if (listTemplates().length === 0) templates.value = seedTemplates();
		if (listOuts().length === 0) outs.value = [createDefaultOut(defaultOutId)];
		if (Object.keys(readData()).length === 0) titleData.value = seedData();
		meta.value = { initialized: true, schemaVersion: 1 };
		log.info("Seeded default templates, out and sample data");
	}

	return {
		nodecg,
		templates,
		outs,
		titleData,
		activeTitle,
		runtime,
		selection,
		meta,
		listTemplates,
		getTemplate,
		upsertTemplate,
		patchTemplate,
		removeTemplate,
		listOuts,
		getOut,
		upsertOut,
		patchOut,
		removeOut,
		getItem,
		addPlaying,
		removePlaying,
		markTrigger,
		triggerCount,
		isPlaying,
		playingFor,
		readData,
		setData,
		deleteData,
		readPath,
		readSelection,
		setSelection,
		clearSelection,
		show,
		hide,
		resetActive,
		toggle,
		effectiveData,
		outUrl: outUrlFor,
	};
}

/** Flattens nested objects into dotted paths, e.g. `{a:{b:1}}` -> `[["a.b", 1]]`. */
function flattenEntries(
	value: Record<string, unknown>,
	prefix = "",
): Array<[string, unknown]> {
	const out: Array<[string, unknown]> = [];
	for (const [key, val] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			out.push(...flattenEntries(val as Record<string, unknown>, path));
		} else {
			out.push([path, val]);
		}
	}
	return out;
}
