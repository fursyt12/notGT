import path from "node:path";

import { BUNDLE_NAME, MESSAGES } from "../shared/types";
import { createApiRouter } from "./api";
import { createAccess, type Handler } from "./auth";
import { createMediaRouter } from "./media";
import { createNdiHub, keepNdiKeyFile } from "./ndi";
import { createProjectRouter } from "./project";
import { probeDurationMs } from "./video-duration";
import { syncFileAnimations } from "./file-animations";
import { createSources } from "./sources";
import { Scheduler } from "./scheduler";
import { playTemplateOnce } from "./trigger";
import { createStore, type ServerAPI } from "./store";
import { createTeam } from "./team";
import { createTeamRouter, TEAM_BASE } from "./team-api";
import { createTimers } from "./timers";
import { createWsApi } from "./ws";

/**
 * notGT extension entrypoint.
 *
 * Responsibilities:
 *  - declare + seed the Replicants that hold the whole titling state,
 *  - own playback timers (see `scheduler.ts`),
 *  - expose the REST API and its live counterpart, the WebSocket API, used by
 *    Bitfocus Companion and external systems.
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
	// The team: users, the groups that share outs, and the keys that belong to
	// an out or a group rather than to a person. Kept next to the database.
	const team = createTeam(
		nodecg,
		store,
		path.resolve(__dirname, "..", "..", "..", "db", `${BUNDLE_NAME}-team.json`),
	);
	// NodeCG's own login and its session checks ask the team about the users
	// it does not list itself, and about the keys of the OBS links: such a key
	// opens the page of its out (and the files that page loads), read-only.
	const graphics = `/bundles/${BUNDLE_NAME}/graphics/`;
	(
		nodecg.util as unknown as {
			setAccessProvider?(provider: unknown): void;
		}
	).setAccessProvider?.({
		verifyUser: (username: string, password: string) => team.loginEnabled && team.verifyUser(username, password),
		hasUser: (username: string) => team.hasUser(username),
		defaultSignIn: () => team.defaultSignIn(),
		findKey: (key: string) => {
			const outId = team.findOut(key);
			if (!outId) return undefined;
			return {
				allows: ({ path: requested, query }: { path: string; query: Record<string, unknown> }) =>
					requested === `${graphics}out.html`
						? query["out"] === outId
						: requested.startsWith(graphics) || requested.startsWith("/assets/"),
				// Its timers run on the server's clock.
				sends: ({ bundleName, messageName }: { bundleName: string; messageName: string }) =>
					bundleName === BUNDLE_NAME && messageName === MESSAGES.clock,
			};
		},
	});
	store.setOutKeys((outId) => team.outKey(outId));
	mount(TEAM_BASE, createTeamRouter(nodecg, team, nodecg.util.authCheck as unknown as Handler));

	// Countdowns and stopwatches, shared with the groups of the team.
	const timers = createTimers(nodecg, {
		hasGroup: (id) => team.hasGroup(id),
		seed: store.timerSeeds,
	});

	// One answer to "who may drive the show" for both APIs.
	const access = createAccess(nodecg, team);
	// The outs that also go out over NDI, for the senders to pick up.
	const ndi = createNdiHub(nodecg, store);
	// docker-compose.yml's NDI sender reads its key from a folder it shares
	// with this container. Without the sign-in the key is the `apiToken`, if any.
	const ndiKeyFile = process.env["NOTGT_NDI_KEY_FILE"]?.trim();
	if (ndiKeyFile) {
		keepNdiKeyFile(
			nodecg,
			ndiKeyFile,
			() => team.ndiKey() ?? ((nodecg.bundleConfig?.apiToken as string | undefined) ?? "").trim(),
			(listener) => team.onChange(listener),
		);
	}
	const router = createApiRouter(nodecg, store, scheduler, {
		access,
		syncAnimations,
		videoDuration,
		timers,
		ndi,
	});
	mount("/api", router);
	mount(`/bundles/${BUNDLE_NAME}/api`, router);

	// The same verbs over a WebSocket, with the state pushed instead of polled.
	const ws = createWsApi(nodecg, store, scheduler, access, team, timers);

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

	// Spreadsheets as list variables. The working copies of loaded workbooks
	// live in the assets tree too, next to the media.
	const sources = createSources(
		nodecg,
		store,
		path.join(assetsRoot, BUNDLE_NAME, "sources"),
		nodecg.util.authCheck as unknown as Handler,
	);
	mount(`/bundles/${BUNDLE_NAME}/sources`, sources.router);
	sources.start();

	// The show as one file: saved from here, opened here or on another server.
	mount(
		`/bundles/${BUNDLE_NAME}/project`,
		createProjectRouter(nodecg, store, {
			mediaDir,
			mediaUrlPrefix,
			sessionCheck: nodecg.util.authCheck as unknown as Handler,
			team,
			boundVariables: () => sources.variables(),
			offAir: () => {
				scheduler.stopOut(null);
				store.hide();
			},
		}),
	);

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

	// "Clear the air" from the dashboard. Held placements are switched off
	// through the `outs` Replicant; this drops the one-shots still in flight.
	nodecg.listenFor(MESSAGES.stop, ((data: any, ack: any) => {
		scheduler.stopOut(data?.outId ?? null);
		if (ack && !ack.handled) ack(null, { ok: true });
	}) as any);

	// Out pages ask the extension to re-sync (e.g. after a reconnect).
	nodecg.listenFor(MESSAGES.refresh, ((_data: any, ack: any) => {
		scheduler.sync();
		const files = syncAnimations();
		if (ack && !ack.handled) ack(null, { ok: true, ...files });
	}) as any);

	nodecg.listenFor("serverStopping", (() => {
		scheduler.dispose();
		timers.dispose();
		ndi.dispose();
		ws?.close();
	}) as any);

	// Re-derive playback whenever outs/templates are edited from the dashboard.
	store.outs.on("change", () => scheduler.sync());

	nodecg.log.info(
		"notGT ready — REST API on /api (state, titles/show|hide|toggle|trigger, data, templates, outs, timers, animations, ndi)",
	);
	if (ws) nodecg.log.info("WebSocket API on %s (state push, the same verbs)", ws.paths[0]);
	if (access.loginEnabled) {
		nodecg.log.info(
			"Login is on: the dashboard asks for a username and password%s",
			access.ws.hasToken ? "" : "; integrations sign in with the same pair (no `wsToken` or `apiToken` is set)",
		);
	}
	if (syncResult.total > 0 || syncResult.removed > 0) {
		nodecg.log.info(
			"File animations: %d registered from graphics/animations (%d added, %d removed)",
			syncResult.total,
			syncResult.added,
			syncResult.removed,
		);
	}

	return { store, scheduler };
}
