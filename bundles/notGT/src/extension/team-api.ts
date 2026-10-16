import { TEAM_BASE } from "../shared/team";
import { type ApiRequest, type ApiResponse, type Handler, isCrossSite } from "./auth";
import type { ServerAPI } from "./store";
import { type Team, TeamError } from "./team";

interface Router {
	get(path: string, ...handlers: Handler[]): void;
	post(path: string, ...handlers: Handler[]): void;
	patch(path: string, ...handlers: Handler[]): void;
	delete(path: string, ...handlers: Handler[]): void;
	use(...handlers: Handler[]): void;
}

/**
 * The Team panel's side of the team: who am I (`/me`), and — for an
 * administrator — users, groups and keys.
 *
 * It is reached with the dashboard's session, not with an API token: managing
 * the team is something a person does, signed in. So it only answers our own
 * pages (see `isCrossSite`).
 */
export function createTeamRouter(nodecg: ServerAPI, team: Team, sessionCheck: Handler): unknown {
	const router = nodecg.Router() as unknown as Router;

	const who = (req: ApiRequest): string | null =>
		(req as unknown as { user?: { name?: string } }).user?.name ?? null;
	const body = (req: ApiRequest): Record<string, unknown> =>
		typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
			? (req.body as Record<string, unknown>)
			: {};
	/** Runs a handler and turns what the team refuses into its HTTP answer. */
	const answer =
		(status: number, run: (req: ApiRequest) => unknown): Handler =>
		(req, res) => {
			try {
				res.status(status).json(run(req) ?? { ok: true });
			} catch (error) {
				if (!(error instanceof TeamError)) throw error;
				res.status(error.status).json({ error: error.code, message: error.message });
			}
		};

	router.use((req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		if (isCrossSite(req)) {
			res.status(403).json({ error: "forbidden", message: "The team is managed from the dashboard" });
			return;
		}
		next();
	});
	router.use(sessionCheck);

	router.get("/me", answer(200, (req) => team.me(who(req))));

	const adminOnly: Handler = (req, res, next) => {
		if (team.roleOf(who(req)) === "admin") {
			next();
			return;
		}
		res.status(403).json({ error: "forbidden", message: "Only an administrator manages the team" });
	};
	router.use(adminOnly);

	router.get("/state", answer(200, () => team.state()));

	router.post("/users", answer(201, (req) => ({ user: team.createUser(body(req)) })));
	router.patch("/users/:id", answer(200, (req) => ({ user: team.updateUser(req.params["id"]!, body(req)) })));
	router.delete("/users/:id", answer(200, (req) => team.deleteUser(req.params["id"]!)));

	router.post("/groups", answer(201, (req) => ({ group: team.createGroup(body(req)) })));
	router.patch("/groups/:id", answer(200, (req) => ({ group: team.updateGroup(req.params["id"]!, body(req)) })));
	router.delete("/groups/:id", answer(200, (req) => team.deleteGroup(req.params["id"]!)));
	router.post(
		"/groups/:id/keys",
		answer(201, (req) => ({ group: team.addGroupKey(req.params["id"]!, body(req)["label"]) })),
	);
	router.delete(
		"/groups/:id/keys/:keyId",
		answer(200, (req) => ({ group: team.removeGroupKey(req.params["id"]!, req.params["keyId"]!) })),
	);

	// A new key for an out's OBS link; the old link stops working at once.
	router.post("/outs/:id/key", answer(200, (req) => ({ key: team.regenerateOutKey(req.params["id"]!) })));
	// A new key for the NDI senders; a sender with the old one is refused at once.
	router.post("/ndi/key", answer(200, () => ({ key: team.regenerateNdiKey() })));

	return router;
}

export { TEAM_BASE };
