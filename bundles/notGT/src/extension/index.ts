import path from "node:path";

import { BUNDLE_NAME, MESSAGES } from "../shared/types";
import { createApiRouter } from "./api";
import type { Handler } from "./auth";
import { createMediaRouter } from "./media";
import { probeDurationMs } from "./video-duration";
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

	// Where served media lives on disk, so the scheduler can measure a clip.
	const assetsRoot = path.resolve(__dirname, "..", "..", "..", "assets");
	const mediaRoots = {
		assetsDir: assetsRoot,
		graphicsDir: path.resolve(__dirname, "..", "graphics"),
	};
	/** Length of the template's first video layer, if it has a local one. */
	const videoDuration = (templateId: string): number | undefined => {
		const template = store.getTemplate(templateId);
		const layer = template?.layers?.find((l) => l.type === "video" && l.src);
		return layer ? probeDurationMs(layer.src, mediaRoots) : undefined;
	};

	const scheduler = new Scheduler(nodecg, store, videoDuration);

	// Mount under both the canonical `/api` (short, Companion friendly) and the
	// bundle-scoped path, so it also works behind a path-prefixed reverse proxy.
	// Animations authored as files in `graphics/animations/` become templates
	// that point at the file; re-run with `POST /api/animations/sync` after
	// dropping a new file in (a restart is not required).
	const syncAnimations = () => syncFileAnimations(store, __dirname);
	const syncResult = syncAnimations();

	const mount = nodecg.mount as unknown as (path: string, handler: unknown) => void;
	const router = createApiRouter(nodecg, store, scheduler, {
		syncAnimations,
		videoDuration,
	});
	mount("/api", router);
	mount(`/bundles/${BUNDLE_NAME}/api`, router);

	// Drag-and-dropped media for the `video` layer. Lives in the NodeCG assets
	// tree (a Docker volume), so uploads survive a container rebuild. Guarded by
	// NodeCG's own session check, not by the API token: the dashboard panel has
	// no token and must not need one.
	const mediaDir = nodecg.bundleConfig?.mediaDir
		? path.resolve(nodecg.bundleConfig.mediaDir)
		: path.join(assetsRoot, BUNDLE_NAME, "media");
	const mediaUrlPrefix = `/assets/${BUNDLE_NAME}/media/`;
	const mediaRouter = createMediaRouter(
		nodecg,
		mediaDir,
		mediaUrlPrefix,
		nodecg.util.authCheck as unknown as Handler,
	);
	mount(`/bundles/${BUNDLE_NAME}/media`, mediaRouter);
	nodecg.log.info("Media drop zone: %s → %s", mediaUrlPrefix, mediaDir);

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
