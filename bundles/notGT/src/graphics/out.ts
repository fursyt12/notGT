import {
	clone,
	flattenData,
	materializeSelection,
	setByPath,
} from "../shared/binding";
import {
	getNodecg,
	waitForReplicants,
	type ClientReplicant,
} from "../shared/client";
import {
	BUNDLE_NAME,
	CODE_MESSAGES,
	type ItemCrop,
	type Out,
	REPLICANTS,
	type RuntimeState,
	type TitleData,
	type TitleTemplate,
	type ActiveTitleState,
	type VariableSelection,
} from "../shared/types";
import { cropBox } from "../shared/crop";
import {
	CODE_HOOKS_TIMEOUT_MS,
	buildCodeDocument,
	buildSourcedDocument,
	codeExitBudgetMs,
	codeSource,
} from "./code-runtime";
import {
	createLayerElement,
	pauseVideoLayers,
	restartVideoLayers,
	updateLayerContent,
} from "./layers";
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
	/** Visible window inside the design box, or `null` for the whole box. */
	crop: ItemCrop | null;
	/** Design size of the out, for placing a crop window (px -> percent). */
	outW: number;
	outH: number;
}

/** Which phases a code animation animates itself, as reported by its runtime. */
interface CodeHooks {
	show: boolean;
	hide: boolean;
	/** How long the exit animation needs, in ms. */
	hideMs: number;
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
	/** Set once the entrance has been dealt with (wrapper or the animation). */
	entered: boolean;
	/** Safety net for a code animation that never reports its hooks. */
	enterTimer?: number;
	codeHooks?: CodeHooks;
	/** Last error thrown inside the animation, for the debug overlay. */
	codeError?: string;
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
const selectionRep = nodecg.Replicant<VariableSelection>(
	REPLICANTS.selection,
	BUNDLE_NAME,
	{ defaultValue: {} },
) as ClientReplicant<VariableSelection>;

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

/** Chosen element per array-valued variable. */
function currentSelection(): VariableSelection {
	return selectionRep.value ?? {};
}

/** Data with arrays collapsed to their selected element (for code iframes). */
function codeData(data: TitleData): TitleData {
	return materializeSelection(data, currentSelection()) as TitleData;
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
			crop: item.crop ? cropBox(item, template) : null,
			outW: out.width,
			outH: out.height,
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
				crop: null,
				outW: out.width,
				outH: out.height,
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
		entered: false,
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

/**
 * Places a slot on the out, with its crop window when it has one.
 *
 * Without a crop the positioner *is* the animation box: `x%`/`y%` from the
 * stage and the template's design size, scaled by `scale`.
 *
 * With a crop the positioner becomes the visible window only. It is sized to
 * the crop, clipped, and moved by the crop's offset inside the box, while the
 * animator underneath is pulled back by the same offset — so the part that is
 * still visible does not move on screen, exactly like the editor canvas shows.
 * The offset is converted from design px to percent of the out, which is the
 * unit `left`/`top` are expressed in (`scale` is in the positioner's transform
 * and does not affect its own layout position).
 */
function applyPlacement(slot: Slot, inst: Instance): void {
	slot.positioner.style.transform = `scale(${inst.scale})`;

	const crop = inst.crop;
	if (!crop) {
		slot.positioner.style.left = `${inst.x}%`;
		slot.positioner.style.top = `${inst.y}%`;
		slot.positioner.style.width = "";
		slot.positioner.style.height = "";
		slot.positioner.style.overflow = "";
		slot.animator.style.left = "";
		slot.animator.style.top = "";
		return;
	}

	const dx = inst.outW > 0 ? (crop.x * inst.scale * 100) / inst.outW : 0;
	const dy = inst.outH > 0 ? (crop.y * inst.scale * 100) / inst.outH : 0;
	slot.positioner.style.left = `${inst.x + dx}%`;
	slot.positioner.style.top = `${inst.y + dy}%`;
	slot.positioner.style.width = `${crop.width}px`;
	slot.positioner.style.height = `${crop.height}px`;
	slot.positioner.style.overflow = "hidden";
	slot.animator.style.left = `${-crop.x}px`;
	slot.animator.style.top = `${-crop.y}px`;
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

	// The inline document is set *before* the iframe enters the document: an
	// iframe that is inserted with an empty `srcdoc` and filled in a moment
	// later occasionally keeps its initial about:blank and paints nothing.
	if (codeSource(template) !== "file" || !template.code?.src) {
		iframe.srcdoc = buildCodeDocument(template, data);
		slot.box.appendChild(iframe);
		return;
	}

	slot.box.appendChild(iframe);
	{
		const src = template.code.src;
		buildSourcedDocument(src, codeData(data))
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
	}
}

function rebuildSlot(slot: Slot, template: TitleTemplate, data: TitleData): void {
	slot.box.replaceChildren();
	slot.layerEls.clear();
	slot.iframe = undefined;
	slot.iframeReady = false;
	slot.templateId = template.id;
	slot.signature = signatureOf(template);
	// A fresh iframe means fresh hooks: the animation gets to claim its phases
	// again, exactly like on the first show.
	slot.codeHooks = undefined;
	slot.codeError = undefined;
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
			slot.iframe?.contentWindow?.postMessage(
				{ type: CODE_MESSAGES.data, data: codeData(data) },
				"*",
			);
		}
		return;
	}
	const selection = currentSelection();
	for (const layer of template.layers ?? []) {
		const el = slot.layerEls.get(layer.id);
		if (el) updateLayerContent(el, layer, data, selection);
	}
}

// ---------------------------------------------------------------------------
// Who animates the entrance and the exit
//
// A code animation decides for itself. Its runtime reports which phases it
// handles (`notgt:code-hooks`); when it claims one, the out page leaves that
// phase alone instead of animating the wrapper on top of it, and for the exit
// it keeps the iframe alive until the animation says it is done (`hideDone()`)
// or until the time it asked for runs out. Everything else keeps the template's
// inTransition / outTransition exactly as before.
// ---------------------------------------------------------------------------

function postToSlot(slot: Slot, message: Record<string, unknown>): void {
	slot.iframe?.contentWindow?.postMessage(message, "*");
}

/** Starts the entrance: the wrapper now, or once the animation has spoken. */
function enterSlot(slot: Slot, template: TitleTemplate): void {
	slot.entered = false;
	if (slot.enterTimer !== undefined) {
		window.clearTimeout(slot.enterTimer);
		slot.enterTimer = undefined;
	}
	if (template.kind !== "code") {
		finishEnter(slot, template);
		return;
	}
	// Give the animation a moment to report its hooks, so a code-owned entrance
	// is not preceded by the wrapper's own transition. Without an answer the
	// wrapper takes over, which is the pre-hooks behaviour.
	slot.enterTimer = window.setTimeout(() => {
		slot.enterTimer = undefined;
		finishEnter(slot, template);
	}, CODE_HOOKS_TIMEOUT_MS);
}

function finishEnter(slot: Slot, template: TitleTemplate): void {
	if (slot.entered) return;
	slot.entered = true;
	if (slot.enterTimer !== undefined) {
		window.clearTimeout(slot.enterTimer);
		slot.enterTimer = undefined;
	}
	if (slot.codeHooks?.show) {
		// The animation animates its own entrance, and it already did: a fresh
		// iframe starts in the "in" phase, so its onShow handlers ran when the
		// script registered them. Sending the phase here would play it twice —
		// the out page only sends "in" again to *replay* (see `replayEnter`).
		return;
	}
	// A code animation owns its transitions: if it did not take the entrance,
	// nothing animates it. The template's inTransition is for `layers` only.
	if (template.kind === "code") return;
	enterAnimation(slot.animator, template.inTransition);
}

/** Replays the entrance of a slot that is already on screen (a re-trigger). */
function replayEnter(slot: Slot, template: TitleTemplate): void {
	if (slot.codeHooks?.show) {
		postToSlot(slot, { type: CODE_MESSAGES.phase, phase: "in" });
		return;
	}
	if (template.kind === "code") return;
	enterAnimation(slot.animator, template.inTransition);
}

/** Plays the exit, then calls `done` — the caller removes the slot there. */
function exitSlot(slot: Slot, template: TitleTemplate | undefined, done: () => void): void {
	const hooks = slot.codeHooks;
	if (template?.kind === "code" && hooks?.hide && slot.iframe?.contentWindow) {
		// The scheduler already started this exit early when the template
		// declares `code.exitMs`, so waiting here finishes it exactly at the
		// configured end of the hold.
		const wait = codeExitBudgetMs(template, hooks.hideMs);
		const source = slot.iframe.contentWindow;
		const timer = window.setTimeout(() => {
			pendingExits.delete(source);
			done();
		}, wait);
		pendingExits.set(source, () => {
			window.clearTimeout(timer);
			done();
		});
		postToSlot(slot, { type: CODE_MESSAGES.phase, phase: "out" });
		return;
	}
	// Same rule on the way out: a code animation that did not take the exit
	// leaves instantly instead of getting a wrapper transition it never asked
	// for. Only `layers` templates use outTransition.
	if (template?.kind === "code") {
		done();
		return;
	}
	exitAnimation(slot.animator, template?.outTransition, done);
}

/** Exit animations in flight, by iframe window, so `hideDone()` can end them. */
const pendingExits = new Map<Window, () => void>();

window.addEventListener("message", (event: MessageEvent) => {
	const message = event.data as { type?: string; show?: unknown; hide?: unknown; hideMs?: unknown };
	if (!message || typeof message !== "object") return;

	if (message.type === CODE_MESSAGES.phaseDone) {
		const done = pendingExits.get(event.source as Window);
		if (done) {
			pendingExits.delete(event.source as Window);
			done();
		}
		return;
	}

	if (message.type === CODE_MESSAGES.error) {
		const slot = [...slots.values()].find(
			(candidate) => candidate.iframe?.contentWindow === event.source,
		);
		const error = message as {
			message?: unknown;
			source?: unknown;
			line?: unknown;
			col?: unknown;
		};
		const where = error.line ? ` (${String(error.source)}:${String(error.line)})` : "";
		const text = `${String(error.message ?? "ошибка")}${where}`;
		console.error("[notGT] ошибка в код-анимации:", text);
		if (slot && slot.codeError !== text) {
			slot.codeError = text;
			scheduleRender();
		}
		return;
	}

	if (message.type !== CODE_MESSAGES.hooks) return;
	const slot = [...slots.values()].find(
		(candidate) => candidate.iframe?.contentWindow === event.source,
	);
	if (!slot) return;
	const template = templates().find((candidate) => candidate.id === slot.templateId);
	if (!template) return;
	slot.codeHooks = {
		show: message.show === true,
		hide: message.hide === true,
		hideMs: typeof message.hideMs === "number" && isFinite(message.hideMs) ? message.hideMs : 0,
	};
	if (!slot.entered) finishEnter(slot, template);
});

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
		pauseVideoLayers(slot.layerEls);
		exitSlot(slot, template, () => {
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
			pauseVideoLayers(stale.layerEls);
			exitSlot(stale, staleTemplate, () => {
				stale.positioner.remove();
			});
			slot = undefined;
		}

		if (!slot) {
			slot = createSlot(inst, template);
			slots.set(inst.key, slot);
			enterSlot(slot, template);
			restartVideoLayers(slot.layerEls);
			slot.lastTrigger = inst.trigger;
		} else {
			applyPlacement(slot, inst);
			if (slot.signature !== signatureOf(template)) {
				rebuildSlot(slot, template, inst.data);
				enterSlot(slot, template);
				restartVideoLayers(slot.layerEls);
				slot.lastTrigger = inst.trigger;
			} else if (inst.trigger !== slot.lastTrigger) {
				// Re-triggered while already on screen: replay the entrance.
				slot.lastTrigger = inst.trigger;
				replayEnter(slot, template);
				restartVideoLayers(slot.layerEls);
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
	const lines = [
		`out: ${out ? out.id : `НЕ НАЙДЕН (${explicitOut ?? "?"})`}`,
		`revision: ${runtimeRep.value?.revision ?? 0}`,
		`playing: ${playing.length ? playing.join(", ") : "-"}`,
		`slots: ${desired.map((d) => d.key).join(", ") || "-"}`,
	];

	// Point at the likely cause instead of leaving an empty transparent frame.
	if (!out) {
		lines.push("", "→ такого out'а нет. Проверьте ?out= в URL источника.");
	} else if (desired.length === 0) {
		lines.push("", "→ на этом out'е сейчас ничего не показывается.");
		lines.push("  Покажите анимацию (Показать в редакторе) или включите");
		lines.push("  «показать» / autoStart у размещения в панели Control.");
	}

	// Video layers fail silently on air, so report them explicitly.
	const videos = [...document.querySelectorAll("video.notgt-layer")] as HTMLVideoElement[];
	if (videos.length > 0) {
		const broken = videos.filter((v) => v.error || v.readyState === 0);
		lines.push(
			`video: ${videos.length} шт., проблемных ${broken.length}` +
				(broken.length
					? ` — код ${broken.map((v) => v.error?.code ?? "нет данных").join(", ")}`
					: ` (${videos.map((v) => v.videoWidth).join("x")})`),
		);
	}

	// An animation that throws leaves an empty frame and says nothing by itself.
	const failed = [...slots.values()].filter((slot) => slot.codeError);
	if (failed.length > 0) {
		lines.push("", "→ код-анимация падает:");
		for (const slot of failed) lines.push(`  ${slot.templateId}: ${slot.codeError}`);
	}

	debugEl.textContent = lines.join("\n");
}

// --------------------------------------------------------------------- wiring

templatesRep.on("change", scheduleRender);
outsRep.on("change", scheduleRender);
titleDataRep.on("change", scheduleRender);
activeTitleRep.on("change", scheduleRender);
runtimeRep.on("change", scheduleRender);
selectionRep.on("change", scheduleRender);

// Top-level `await` would force the bundler to target ES2022; a promise chain
// keeps the output valid for older CEF builds used by OBS.
void waitForReplicants(
	templatesRep,
	outsRep,
	titleDataRep,
	activeTitleRep,
	runtimeRep,
	selectionRep,
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
