import {
	defaultPlayback,
	defaultTransition,
	newId,
	type Out,
	type OutItem,
	type PublicState,
	slugify,
	type TitleData,
	type TitleTemplate,
} from "../shared/types";
import {
	type ApiRequest,
	type ApiResponse,
	corsHeaders,
	createApiAuth,
	type Handler,
	type NextFn,
} from "./auth";
import type { Scheduler } from "./scheduler";
import { playTemplateOnce } from "./trigger";
import type { BundleConfig, ServerAPI, Store } from "./store";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	put(path: string, ...handlers: Handler[]): void;
	patch(path: string, ...handlers: Handler[]): void;
	delete(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

export interface ApiHooks {
	/** Re-scans `graphics/animations/` for file-authored animations. */
	syncAnimations?: () => { added: number; total: number };
}

export function createApiRouter(
	nodecg: ServerAPI,
	store: Store,
	scheduler: Scheduler,
	hooks: ApiHooks = {},
): unknown {
	const router = nodecg.Router() as unknown as Router;
	const config = (nodecg.bundleConfig ?? {}) as BundleConfig;

	router.use(corsHeaders as Handler);
	router.use(createApiAuth(nodecg) as Handler);

	// ---------------------------------------------------------------- health
	router.get("/health", (_req, res) => {
		json(res, 200, { ok: true, bundle: "notGT", uptime: process.uptime() });
	});

	// ----------------------------------------------------------------- state
	router.get("/state", (_req, res) => {
		json(res, 200, buildPublicState(store, config));
	});

	// ------------------------------------------------------------------ data
	router.get("/data", (req, res) => {
		const path = pickString(req.query["path"]);
		if (path) {
			json(res, 200, { path, value: store.readPath(path) });
			return;
		}
		json(res, 200, { data: store.readData() });
	});

	router.post("/data", (req, res) => {
		const body = asObject(req.body);
		const mode = pickString(req.query["mode"]) === "replace" ? "replace" : "merge";
		const patch = isPlainObject(body["data"])
			? (body["data"] as TitleData)
			: (body as TitleData);
		const data = store.setData(patch, mode);
		json(res, 200, { ok: true, mode, data });
	});

	router.delete("/data/:path(*)", (req, res) => {
		const path = req.params["path"];
		if (!path) {
			json(res, 400, { error: "bad_request", message: "Missing data path" });
			return;
		}
		json(res, 200, { ok: true, data: store.deleteData(path) });
	});

	// ------------------------------------------------- animation files on disk
	router.get("/animations", (_req, res) => {
		const files = store
			.listTemplates()
			.filter((template) => Boolean(template.code?.src))
			.map((template) => ({
				id: template.id,
				name: template.name,
				src: template.code?.src,
				inlined: Boolean(template.code?.html?.trim()),
			}));
		json(res, 200, { animations: files });
	});

	router.post("/animations/sync", (_req, res) => {
		const result = hooks.syncAnimations?.() ?? { added: 0, total: 0 };
		json(res, 200, { ok: true, ...result });
	});

	// ------------------------------------------------------------- templates
	router.get("/templates", (_req, res) => {
		json(res, 200, { templates: store.listTemplates() });
	});

	router.post("/templates", (req, res) => {
		const body = asObject(req.body);
		const template = normalizeTemplate(body);
		if (!template) {
			json(res, 400, {
				error: "bad_request",
				message: "A template needs at least a `name` or an `id`",
			});
			return;
		}
		json(res, 201, { ok: true, template: store.upsertTemplate(template) });
	});

	router.get("/templates/:id", (req, res) => {
		const template = store.getTemplate(req.params["id"]!);
		if (!template) return notFound(res, "template", req.params["id"]!);
		json(res, 200, { template });
	});

	const updateTemplate: Handler = (req, res) => {
		const id = req.params["id"]!;
		const existing = store.getTemplate(id);
		if (!existing) return notFound(res, "template", id);
		const body = asObject(req.body);
		const merged = normalizeTemplate({ ...existing, ...body, id }, existing)!;
		json(res, 200, { ok: true, template: store.upsertTemplate(merged) });
	};
	router.put("/templates/:id", updateTemplate);
	router.patch("/templates/:id", updateTemplate);

	router.delete("/templates/:id", (req, res) => {
		const id = req.params["id"]!;
		const removed = store.removeTemplate(id);
		if (!removed) return notFound(res, "template", id);
		scheduler.sync();
		json(res, 200, { ok: true, id });
	});

	// ------------------------------------------------------------ title verbs
	router.post("/titles/hide", (req, res) => {
		const body = asObject(req.body);
		const outId = pickString(body["out"] ?? body["outId"] ?? req.query["out"]);
		const templateId = pickString(body["templateId"] ?? req.query["templateId"]);
		const active = store.hide({ outId: outId ?? undefined, templateId });
		if (!templateId) scheduler.stopOut(outId ?? undefined);
		json(res, 200, { ok: true, active });
	});

	router.post("/titles/:templateId/show", (req, res) => {
		const templateId = req.params["templateId"]!;
		const { outId, data, label } = parseTitleBody(req);
		const active = store.show(templateId, { outId, data, label });
		if (!active) return notFound(res, "template", templateId);
		json(res, 200, { ok: true, active });
	});

	router.post("/titles/:templateId/toggle", (req, res) => {
		const templateId = req.params["templateId"]!;
		const { outId, data, label } = parseTitleBody(req);
		const active = store.toggle(templateId, { outId, data, label });
		if (!active) return notFound(res, "template", templateId);
		json(res, 200, { ok: true, active });
	});

	/**
	 * One-shot playback. If the template is placed on an out, that placement is
	 * triggered; otherwise it is shown through the manual layer and hidden again
	 * after `holdMs`.
	 */
	router.post("/titles/:templateId/trigger", (req, res) => {
		const templateId = req.params["templateId"]!;
		const { outId, data, label, holdMs } = parseTitleBody(req);
		const result = playTemplateOnce(store, scheduler, templateId, {
			outId,
			holdMs,
			data,
			label,
		});
		if (!result) return notFound(res, "template", templateId);
		json(res, 200, { ok: true, ...result, active: store.activeTitle.value });
	});

	// ------------------------------------------------------------------ outs
	router.get("/outs", (_req, res) => {
		json(res, 200, { outs: store.listOuts() });
	});

	router.post("/outs", (req, res) => {
		const body = asObject(req.body);
		const out = normalizeOut(body);
		if (store.getOut(out.id)) {
			json(res, 409, { error: "conflict", message: `Out "${out.id}" already exists` });
			return;
		}
		json(res, 201, { ok: true, out: store.upsertOut(out) });
	});

	router.get("/outs/:id", (req, res) => {
		const out = store.getOut(req.params["id"]!);
		if (!out) return notFound(res, "out", req.params["id"]!);
		json(res, 200, { out, url: store.outUrl(out.id) });
	});

	const updateOut: Handler = (req, res) => {
		const id = req.params["id"]!;
		const existing = store.getOut(id);
		if (!existing) return notFound(res, "out", id);
		const body = asObject(req.body);
		const merged = normalizeOut({ ...existing, ...body, id }, existing);
		const out = store.upsertOut(merged);
		scheduler.sync();
		json(res, 200, { ok: true, out, url: store.outUrl(out.id) });
	};
	router.put("/outs/:id", updateOut);
	router.patch("/outs/:id", updateOut);

	router.delete("/outs/:id", (req, res) => {
		const id = req.params["id"]!;
		if (!store.removeOut(id)) return notFound(res, "out", id);
		scheduler.sync();
		json(res, 200, { ok: true, id });
	});

	router.get("/outs/:id/url", (req, res) => {
		const id = req.params["id"]!;
		if (!store.getOut(id)) return notFound(res, "out", id);
		json(res, 200, { url: store.outUrl(id) });
	});

	router.post("/outs/:outId/stop", (req, res) => {
		const outId = req.params["outId"]!;
		scheduler.stopOut(outId);
		json(res, 200, { ok: true, outId });
	});

	// -------------------------------------------------------------- out items
	router.post("/outs/:outId/items", (req, res) => {
		const outId = req.params["outId"]!;
		const out = store.getOut(outId);
		if (!out) return notFound(res, "out", outId);
		const body = asObject(req.body);
		const templateId = pickString(body["templateId"]);
		if (!templateId || !store.getTemplate(templateId)) {
			json(res, 400, { error: "bad_request", message: "Unknown or missing templateId" });
			return;
		}
		const item = normalizeItem({ ...body, templateId }, out.items.length);
		const next: Out = { ...out, items: [...out.items, item] };
		store.upsertOut(next);
		scheduler.sync();
		json(res, 201, { ok: true, item, out: store.getOut(outId) });
	});

	const updateItem: Handler = (req, res) => {
		const outId = req.params["outId"]!;
		const itemId = req.params["itemId"]!;
		const out = store.getOut(outId);
		if (!out) return notFound(res, "out", outId);
		const index = out.items.findIndex((i) => i.id === itemId);
		if (index < 0) return notFound(res, "item", itemId);
		const body = asObject(req.body);
		const merged = normalizeItem({ ...out.items[index]!, ...body, id: itemId }, index);
		const items = [...out.items];
		items[index] = merged;
		store.upsertOut({ ...out, items });
		scheduler.sync();
		json(res, 200, { ok: true, item: merged });
	};
	router.put("/outs/:outId/items/:itemId", updateItem);
	router.patch("/outs/:outId/items/:itemId", updateItem);

	router.delete("/outs/:outId/items/:itemId", (req, res) => {
		const outId = req.params["outId"]!;
		const itemId = req.params["itemId"]!;
		const out = store.getOut(outId);
		if (!out) return notFound(res, "out", outId);
		if (!out.items.some((i) => i.id === itemId)) return notFound(res, "item", itemId);
		store.upsertOut({ ...out, items: out.items.filter((i) => i.id !== itemId) });
		scheduler.sync();
		json(res, 200, { ok: true, itemId });
	});

	router.post("/outs/:outId/items/:itemId/trigger", (req, res) => {
		const outId = req.params["outId"]!;
		const itemId = req.params["itemId"]!;
		const body = asObject(req.body);
		const holdMs = pickNumber(body["holdMs"] ?? req.query["holdMs"]);
		if (!scheduler.trigger(outId, itemId, holdMs)) {
			return notFound(res, "item", `${outId}/${itemId}`);
		}
		json(res, 200, { ok: true, outId, itemId });
	});

	return router;
}

// --------------------------------------------------------------------- utils

export function buildPublicState(store: Store, config: BundleConfig): PublicState {
	const active = store.activeTitle.value ?? {
		templateId: null,
		visible: false,
		outId: null,
		data: {},
		updatedAt: 0,
	};
	const runtime = store.runtime.value ?? { playing: {}, revision: 0 };
	const state: PublicState = {
		active,
		// `data` can be huge; keep the feedback payload lean.
		activeTemplateId: active.templateId,
		activeVisible: active.visible,
		activeOutId: active.outId,
		playing: runtime.playing,
		revision: runtime.revision,
	};
	if (!config.hideApiState) {
		state.outs = store.listOuts().map((out) => ({
			id: out.id,
			name: out.name,
			width: out.width,
			height: out.height,
			url: store.outUrl(out.id),
		}));
		state.templates = store.listTemplates().map((template) => ({
			id: template.id,
			name: template.name,
			kind: template.kind,
		}));
	}
	return state;
}

function parseTitleBody(req: ApiRequest): {
	outId: string | null;
	data?: TitleData;
	label?: string;
	holdMs?: number;
} {
	const body = asObject(req.body);
	const outIdRaw = body["out"] ?? body["outId"] ?? req.query["out"];
	const outId = pickString(outIdRaw) ?? null;
	const label = pickString(body["label"] ?? req.query["label"]);
	const holdMs = pickNumber(body["holdMs"] ?? req.query["holdMs"]);

	let data: TitleData | undefined;
	if (isPlainObject(body["data"])) {
		data = body["data"] as TitleData;
	} else {
		const { out: _o, outId: _oi, label: _l, holdMs: _h, ...rest } = body;
		if (Object.keys(rest).length > 0) data = rest as TitleData;
	}
	return { outId, data, label, holdMs };
}

export function normalizeTemplate(
	input: Record<string, unknown>,
	existing?: TitleTemplate,
): TitleTemplate | undefined {
	const name = pickString(input["name"]) ?? existing?.name;
	const id = pickString(input["id"]) ?? existing?.id ?? (name ? slugify(name, "template") : undefined);
	if (!id || !name) return undefined;
	const base = existing ?? {
		id,
		name,
		kind: "layers" as const,
		width: 1920,
		height: 1080,
		layers: [],
		inTransition: defaultTransition(),
		outTransition: defaultTransition(),
		playback: defaultPlayback(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	return {
		...base,
		...input,
		id,
		name,
		kind: input["kind"] === "code" ? "code" : base.kind,
		width: pickNumber(input["width"]) ?? base.width,
		height: pickNumber(input["height"]) ?? base.height,
		layers: Array.isArray(input["layers"]) ? (input["layers"] as TitleTemplate["layers"]) : base.layers,
		code: isPlainObject(input["code"])
			? (input["code"] as unknown as TitleTemplate["code"])
			: base.code,
		inTransition: mergeTransition(input["inTransition"], base.inTransition),
		outTransition: mergeTransition(input["outTransition"], base.outTransition),
		playback: mergePlayback(input["playback"], base.playback),
		updatedAt: Date.now(),
	};
}

function mergeTransition(value: unknown, base: TitleTemplate["inTransition"]) {
	if (!isPlainObject(value)) return base;
	return {
		type: (pickString(value["type"]) as TitleTemplate["inTransition"]["type"]) ?? base.type,
		durationMs: pickNumber(value["durationMs"]) ?? base.durationMs,
		easing: pickString(value["easing"]) ?? base.easing,
	};
}

function mergePlayback(value: unknown, base: OutItem["playback"]) {
	if (!isPlainObject(value)) return base;
	const mode = value["mode"] === "loop" ? "loop" : value["mode"] === "once" ? "once" : base.mode;
	return {
		mode,
		intervalMs: pickNumber(value["intervalMs"]) ?? base.intervalMs,
		holdMs: pickNumber(value["holdMs"]) ?? base.holdMs,
		autoStart: typeof value["autoStart"] === "boolean" ? value["autoStart"] : base.autoStart,
	};
}

export function normalizeOut(input: Record<string, unknown>, existing?: Out): Out {
	const name = pickString(input["name"]) ?? existing?.name ?? "Out";
	const id =
		pickString(input["id"]) ??
		existing?.id ??
		slugify(pickString(input["id"]) ?? name, "out");
	const base = existing ?? {
		id,
		name,
		width: 1920,
		height: 1080,
		items: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	return {
		...base,
		...input,
		id,
		name,
		width: pickNumber(input["width"]) ?? base.width,
		height: pickNumber(input["height"]) ?? base.height,
		items: Array.isArray(input["items"])
			? (input["items"] as OutItem[]).map((item, index) =>
					normalizeItem(item as unknown as Record<string, unknown>, index),
				)
			: base.items,
		updatedAt: Date.now(),
	};
}

export function normalizeItem(input: Record<string, unknown>, index = 0): OutItem {
	const base: OutItem = {
		id: pickString(input["id"]) ?? newId("item"),
		templateId: pickString(input["templateId"]) ?? "",
		x: pickNumber(input["x"]) ?? 0,
		y: pickNumber(input["y"]) ?? 0,
		scale: pickNumber(input["scale"]) ?? 1,
		playback: defaultPlayback(),
		enabled: typeof input["enabled"] === "boolean" ? input["enabled"] : true,
		order: pickNumber(input["order"]) ?? index,
	};
	return {
		...base,
		playback: mergePlayback(input["playback"], base.playback),
	};
}

export function asObject(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? (value as Record<string, unknown>) : {};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pickString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (typeof value === "number") return String(value);
	return undefined;
}

export function pickNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function json(res: ApiResponse, status: number, body: unknown): void {
	res.status(status).json(body);
}

function notFound(res: ApiResponse, kind: string, id: string): void {
	json(res, 404, { error: "not_found", message: `Unknown ${kind}: ${id}` });
}
