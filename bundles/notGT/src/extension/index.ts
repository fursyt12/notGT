import { BUNDLE_NAME, MESSAGES } from "../shared/types";
import { createApiRouter } from "./api";
import { syncFileAnimations } from "./file-animations";
import { Scheduler } from "./scheduler";
import { playTemplateOnce } from "./trigger";
import { createStore, type ServerAPI } from "./store";

/**
 * notGT extension entrypoint.
 *
 * Responsibilities:
 *  - declare + seed the Replicants that hold the whole titling state,
 *  - own playback timers (see `scheduler.ts`),
 *  - expose the REST API used by Bitfocus Companion and external systems.
 */
export default function notGTExtension(nodecg: ServerAPI): {
	store: ReturnType<typeof createStore>;
	scheduler: Scheduler;
} {
	const store = createStore(nodecg);
	const scheduler = new Scheduler(nodecg, store);

	// Mount under both the canonical `/api` (short, Companion friendly) and the
	// bundle-scoped path, so it also works behind a path-prefixed reverse proxy.
	// Animations authored as files in `graphics/animations/` become templates
	// that point at the file; re-run with `POST /api/animations/sync` after
	// dropping a new file in (a restart is not required).
	const syncAnimations = () => syncFileAnimations(store, __dirname);
	const syncResult = syncAnimations();

	const mount = nodecg.mount as unknown as (path: string, handler: unknown) => void;
	const router = createApiRouter(nodecg, store, scheduler, { syncAnimations });
	mount("/api", router);
	mount(`/bundles/${BUNDLE_NAME}/api`, router);

	// One-shot triggers from the dashboard / other bundles.
	nodecg.listenFor(MESSAGES.trigger, ((data: any, ack: any) => {
		const payload = data ?? {};
		const holdMs = typeof payload.holdMs === "number" ? payload.holdMs : undefined;
		let result: { triggered: number; mode?: string } = { triggered: 0 };
		if (payload.outId && payload.itemId) {
			result = { triggered: scheduler.trigger(payload.outId, payload.itemId, holdMs) ? 1 : 0 };
		} else if (payload.templateId) {
			// Falls back to a timed manual show when the animation is not placed
			// on any out, so "Preview" in the editor always shows something.
			result =
				playTemplateOnce(store, scheduler, payload.templateId, {
					outId: payload.outId ?? null,
					holdMs,
					data: payload.data,
					label: payload.label,
				}) ?? { triggered: 0 };
		}
		if (ack && !ack.handled) ack(null, result);
	}) as any);

	// Out pages ask the extension to re-sync (e.g. after a reconnect).
	nodecg.listenFor(MESSAGES.refresh, ((_data: any, ack: any) => {
		scheduler.sync();
		const files = syncAnimations();
		if (ack && !ack.handled) ack(null, { ok: true, ...files });
	}) as any);

	nodecg.listenFor("serverStopping", (() => {
		scheduler.dispose();
	}) as any);

	// Re-derive playback whenever outs/templates are edited from the dashboard.
	store.outs.on("change", () => scheduler.sync());

	nodecg.log.info(
		"notGT ready — REST API on /api (state, titles/show|hide|toggle|trigger, data, templates, outs, animations)",
	);
	if (syncResult.total > 0) {
		nodecg.log.info(
			"File animations: %d registered from graphics/animations (%d added)",
			syncResult.total,
			syncResult.added,
		);
	}

	return { store, scheduler };
}
