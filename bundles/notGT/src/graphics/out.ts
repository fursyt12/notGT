import { clone, flattenData, setByPath } from "../shared/binding";
import {
	getNodecg,
	waitForReplicants,
	type ClientReplicant,
} from "../shared/client";
import {
	BUNDLE_NAME,
	type Out,
	REPLICANTS,
	type RuntimeState,
	type TitleData,
	type TitleTemplate,
	type ActiveTitleState,
} from "../shared/types";
import {
	buildCodeDocument,
	buildSourcedDocument,
	codeSource,
} from "./code-runtime";
import { createLayerElement, updateLayerContent } from "./layers";
import { enterAnimation, exitAnimation } from "./transitions";

interface Instance {
	key: string;
	templateId: string;
	itemId?: string;
	x: number;
	y: number;
	scale: number;
	/** Play counter; a change restarts the entrance animation. */
	trigger: number;
	data: TitleData;
}

interface Slot {
	key: string;
	templateId: string;
	signature: string;
	positioner: HTMLDivElement;
	animator: HTMLDivElement;
	box: HTMLDivElement;
	layerEls: Map<string, HTMLElement>;
	iframe?: HTMLIFrameElement;
	iframeReady: boolean;
	/** Guards async file loads against later rebuilds of the same slot. */
	renderToken: number;
	lastTrigger: number;
}

const stage = document.getElementById("notgt-stage") as HTMLDivElement;
const debugEl = document.getElementById("notgt-debug") as HTMLDivElement;
const params = new URLSearchParams(window.location.search);
const debug = params.has("debug");
const explicitOut = params.get("out");

const nodecg = getNodecg();
const templatesRep = nodecg.Replicant<TitleTemplate[]>(
	REPLICANTS.templates,
	BUNDLE_NAME,
	{ defaultValue: [] },
) as ClientReplicant<TitleTemplate[]>;
const outsRep = nodecg.Replicant<Out[]>(REPLICANTS.outs, BUNDLE_NAME, {
	defaultValue: [],
}) as ClientReplicant<Out[]>;
const titleDataRep = nodecg.Replicant<TitleData>(
	REPLICANTS.titleData,
	BUNDLE_NAME,
	{ defaultValue: {} },
) as ClientReplicant<TitleData>;
const activeTitleRep = nodecg.Replicant<ActiveTitleState>(
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
) as ClientReplicant<ActiveTitleState>;
const runtimeRep = nodecg.Replicant<RuntimeState>(
	REPLICANTS.runtime,
	BUNDLE_NAME,
	{ defaultValue: { playing: {}, triggers: {}, revision: 0 } },
) as ClientReplicant<RuntimeState>;

const slots = new Map<string, Slot>();

function templates(): TitleTemplate[] {
	return templatesRep.value ?? [];
}

function outs(): Out[] {
	return outsRep.value ?? [];
}

function baseData(): TitleData {
	return titleDataRep.value ?? {};
}

function outConfig(): Out | undefined {
	const list = outs();
	if (explicitOut) return list.find((o) => o.id === explicitOut);
	return list[0];
}

/** Global variables with the active title's per-show overrides applied. */
function mergedData(): TitleData {
	const merged = clone(baseData());
	const override = activeTitleRep.value?.data ?? {};
	for (const row of flattenData(override)) setByPath(merged, row.path, row.value);
	return merged;
}

function computeInstances(out: Out | undefined): Instance[] {
	const list: Instance[] = [];
	if (!out) return list;

	const playing = runtimeRep.value?.playing?.[out.id] ?? [];
	const byId = new Map(templates().map((t) => [t.id, t]));
	const sorted = [...out.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	for (const item of sorted) {
		if (!item.enabled) continue;
		if (!playing.includes(item.id)) continue;
		const template = byId.get(item.templateId);
		if (!template) continue;
		list.push({
			key: `item:${item.id}`,
			templateId: template.id,
			itemId: item.id,
			x: item.x ?? 0,
			y: item.y ?? 0,
			scale: item.scale ?? 1,
			trigger: runtimeRep.value?.triggers?.[`${out.id}:${item.id}`] ?? 0,
			data: baseData(),
		});
	}

	const active = activeTitleRep.value;
	if (
		active?.visible &&
		active.templateId &&
		(active.outId === null || active.outId === undefined || active.outId === out.id)
	) {
		const template = byId.get(active.templateId);
		if (template) {
			list.push({
				key: "active",
				templateId: template.id,
				x: 0,
				y: 0,
				scale: 1,
				trigger: active.updatedAt ?? 0,
				data: mergedData(),
			});
		}
	}

	return list;
}

function signatureOf(template: TitleTemplate): string {
	return JSON.stringify(template);
}

function createSlot(inst: Instance, template: TitleTemplate): Slot {
	const positioner = document.createElement("div");
	positioner.className = "notgt-slot";
	const animator = document.createElement("div");
	animator.className = "notgt-animator";
	animator.style.width = `${template.width}px`;
	animator.style.height = `${template.height}px`;
	const box = document.createElement("div");
	box.className = "notgt-box";
	positioner.appendChild(animator);
	animator.appendChild(box);

	const slot: Slot = {
		key: inst.key,
		templateId: template.id,
		signature: signatureOf(template),
		positioner,
		animator,
		box,
		layerEls: new Map(),
		iframeReady: false,
		renderToken: 0,
		lastTrigger: inst.trigger,
	};

	if (template.kind === "code") {
		setupCodeIframe(slot, template, inst.data);
	} else {
		for (const layer of sortLayers(template)) {
			const el = createLayerElement(layer);
			slot.layerEls.set(layer.id, el);
			box.appendChild(el);
		}
	}

	stage.appendChild(positioner);
	applyPlacement(slot, inst);
	return slot;
}

function sortLayers(template: TitleTemplate): TitleTemplate["layers"] {
	return [...(template.layers ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
}

function applyPlacement(slot: Slot, inst: Instance): void {
	slot.positioner.style.left = `${inst.x}%`;
	slot.positioner.style.top = `${inst.y}%`;
	slot.positioner.style.transform = `scale(${inst.scale})`;
}

/**
 * Creates the sandboxed iframe for a code animation.
 *
 * Two authoring surfaces share one runtime contract:
 *  - inline HTML/CSS/JS edited in the dashboard  -> injected via `srcdoc`,
 *  - an `.html` file on disk (`code.src`)         -> fetched and injected with
 *    the same runtime prepended, so `vars()` / `onData()` / `[data-bind]` work
 *    identically.
 */
function setupCodeIframe(
	slot: Slot,
	template: TitleTemplate,
	data: TitleData,
): void {
	slot.iframeReady = false;
	const token = ++slot.renderToken;

	const iframe = document.createElement("iframe");
	iframe.className = "notgt-code-frame";
	iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
	iframe.style.width = `${template.width}px`;
	iframe.style.height = `${template.height}px`;
	iframe.addEventListener("load", () => {
		if (slot.renderToken === token) slot.iframeReady = true;
	});
	slot.iframe = iframe;
	slot.box.appendChild(iframe);

	if (codeSource(template) === "file" && template.code?.src) {
		const src = template.code.src;
		buildSourcedDocument(src, data)
			.then((document) => {
				if (slot.iframe === iframe && slot.renderToken === token) {
					iframe.srcdoc = document;
				}
			})
			.catch((error) => {
				console.error("[notGT] failed to load animation file", src, error);
				if (slot.iframe === iframe && slot.renderToken === token) {
					iframe.srcdoc =
						`<body style="font:14px ui-monospace,monospace;color:#ff6666;` +
						`background:rgba(0,0,0,.6);padding:8px">notGT: не удалось загрузить ` +
						`${src}</body>`;
				}
			});
		return;
	}

	iframe.srcdoc = buildCodeDocument(template, data);
}

function rebuildSlot(slot: Slot, template: TitleTemplate, data: TitleData): void {
	slot.box.replaceChildren();
	slot.layerEls.clear();
	slot.iframe = undefined;
	slot.iframeReady = false;
	slot.templateId = template.id;
	slot.signature = signatureOf(template);
	slot.animator.style.width = `${template.width}px`;
	slot.animator.style.height = `${template.height}px`;

	if (template.kind === "code") {
		setupCodeIframe(slot, template, data);
	} else {
		for (const layer of sortLayers(template)) {
			const el = createLayerElement(layer);
			slot.layerEls.set(layer.id, el);
			slot.box.appendChild(el);
		}
	}
}

function updateSlotData(slot: Slot, template: TitleTemplate, data: TitleData): void {
	if (template.kind === "code") {
		if (slot.iframeReady) {
			slot.iframe?.contentWindow?.postMessage({ type: "notgt:data", data }, "*");
		}
		return;
	}
	for (const layer of template.layers ?? []) {
		const el = slot.layerEls.get(layer.id);
		if (el) updateLayerContent(el, layer, data);
	}
}

let scheduled = false;
function scheduleRender(): void {
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(() => {
		scheduled = false;
		render();
	});
}

function render(): void {
	const out = outConfig();
	const list = templates();
	const desired = computeInstances(out);
	const desiredKeys = new Set(desired.map((d) => d.key));

	for (const [key, slot] of [...slots]) {
		if (desiredKeys.has(key)) continue;
		slots.delete(key);
		const template = list.find((t) => t.id === slot.templateId);
		exitAnimation(slot.animator, template?.outTransition, () => {
			slot.positioner.remove();
		});
	}

	for (const inst of desired) {
		const template = list.find((t) => t.id === inst.templateId);
		if (!template) continue;

		let slot = slots.get(inst.key);
		if (slot && slot.templateId !== inst.templateId) {
			const stale = slot;
			slots.delete(inst.key);
			const staleTemplate = list.find((t) => t.id === stale.templateId);
			exitAnimation(stale.animator, staleTemplate?.outTransition, () => {
				stale.positioner.remove();
			});
			slot = undefined;
		}

		if (!slot) {
			slot = createSlot(inst, template);
			slots.set(inst.key, slot);
			enterAnimation(slot.animator, template.inTransition);
			slot.lastTrigger = inst.trigger;
		} else {
			applyPlacement(slot, inst);
			if (slot.signature !== signatureOf(template)) {
				rebuildSlot(slot, template, inst.data);
				enterAnimation(slot.animator, template.inTransition);
				slot.lastTrigger = inst.trigger;
			} else if (inst.trigger !== slot.lastTrigger) {
				// Re-triggered while already on screen: replay the entrance.
				slot.lastTrigger = inst.trigger;
				enterAnimation(slot.animator, template.inTransition);
			}
		}
		updateSlotData(slot, template, inst.data);
	}

	updateDebug(out, desired);
}

function updateDebug(out: Out | undefined, desired: Instance[]): void {
	if (!debug) return;
	debugEl.style.display = "block";
	const playing = out ? (runtimeRep.value?.playing?.[out.id] ?? []) : [];
	debugEl.textContent = [
		`out: ${out ? out.id : `(none${explicitOut ? `: ${explicitOut}` : ""})`}`,
		`revision: ${runtimeRep.value?.revision ?? 0}`,
		`playing: ${playing.length ? playing.join(", ") : "-"}`,
		`slots: ${desired.map((d) => d.key).join(", ") || "-"}`,
	].join("\n");
}

// --------------------------------------------------------------------- wiring

templatesRep.on("change", scheduleRender);
outsRep.on("change", scheduleRender);
titleDataRep.on("change", scheduleRender);
activeTitleRep.on("change", scheduleRender);
runtimeRep.on("change", scheduleRender);

// Top-level `await` would force the bundler to target ES2022; a promise chain
// keeps the output valid for older CEF builds used by OBS.
void waitForReplicants(
	templatesRep,
	outsRep,
	titleDataRep,
	activeTitleRep,
	runtimeRep,
).then(() => {
	if (!outConfig()) {
		console.warn(
			`[notGT] No out matching "${explicitOut ?? "(first out)"}". ` +
				"Create one in the notGT — Titles & Outs panel.",
		);
	}

	render();

	// Keep the debug overlay honest while idle.
	if (debug) setInterval(scheduleRender, 1000);
});
