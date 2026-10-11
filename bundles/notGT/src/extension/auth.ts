import { createHmac, getHashes, timingSafeEqual } from "node:crypto";

import type { BundleConfig, ServerAPI } from "./store";
import type { Team } from "./team";

/** Minimal structural types so the extension does not depend on express types. */
export interface ApiRequest {
	method?: string;
	path?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	query: Record<string, unknown>;
	params: Record<string, string>;
	body?: unknown;
	socket?: { remoteAddress?: string };
	ip?: string;
}

export interface ApiResponse {
	status(code: number): ApiResponse;
	json(body: unknown): void;
	setHeader(name: string, value: string): void;
	end(): void;
}

export type NextFn = (err?: unknown) => void;
export type Handler = (req: ApiRequest, res: ApiResponse, next: NextFn) => void;

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/** The part of NodeCG's own config (`cfg/nodecg.json`) that the login lives in. */
interface LoginConfig {
	enabled?: boolean;
	sessionSecret?: string;
	local?: {
		enabled?: boolean;
		allowedUsers?: ReadonlyArray<{ username: string; password: string }>;
	};
}

/**
 * Who may drive the show from outside the dashboard — one answer for the REST
 * API and the WebSocket.
 *
 * There are two secrets, and either one is enough:
 *  - a key from the bundle config: `apiToken` for REST, `wsToken` for the
 *    WebSocket (which falls back to `apiToken` when it has no key of its own);
 *  - an operator's username and password, when NodeCG's login is switched on
 *    (`login` in `cfg/nodecg.json`) — the same pair that opens the dashboard.
 *
 * With neither configured the API is open.
 */
export interface Access {
	/** `apiToken` is set. */
	readonly hasToken: boolean;
	/** The dashboard is behind NodeCG's login. */
	readonly loginEnabled: boolean;
	/** Operators can sign in with a username and password. */
	readonly hasUsers: boolean;
	/** Nothing is configured: every request is let through. */
	readonly open: boolean;
	checkToken(provided: unknown): boolean;
	checkPassword(username: unknown, password: unknown): boolean;
	/** The WebSocket, which has keys of its own and knows the team. */
	readonly ws: {
		/** A key exists that a client could present: `wsToken` or a group's. */
		readonly hasToken: boolean;
		/** Nothing is configured: every connection is let in, to everything. */
		readonly open: boolean;
		/** Who a key, or a username with a password, lets in — if anyone. */
		signIn(credentials: { token?: unknown; username?: unknown; password?: unknown }): Principal | undefined;
	};
}

/** Whoever is on the other end of a WebSocket, and how far they reach. */
export interface Principal {
	/** The operator's username; null for a key. */
	readonly user: string | null;
	/** The group whose key this is; null for the global key or a user. */
	readonly group: { id: string; name: string } | null;
	/** The outs within reach right now; null = every out. Follows the team as it is edited. */
	outs(): string[] | null;
	/** Still let in: the key was not revoked, the user not removed. */
	valid(): boolean;
}

/** The one an open server lets in, and the holder of the global key. */
export const EVERYTHING: Principal = { user: null, group: null, outs: () => null, valid: () => true };

export function createAccess(nodecg: ServerAPI, team: Team): Access {
	const config = (nodecg.bundleConfig ?? {}) as BundleConfig;
	const token = (config.apiToken ?? "").trim();
	// A key set for the WebSocket replaces `apiToken` there, it does not add to it.
	const wsToken = (config.wsToken ?? "").trim() || token;
	const matches = (provided: unknown, secret: string): boolean =>
		typeof provided === "string" && secret !== "" && safeEqual(provided.trim(), secret);
	const login = ((nodecg.config as unknown as { login?: LoginConfig }).login ?? {}) as LoginConfig;
	const loginEnabled = Boolean(login.enabled);
	const secret = login.sessionSecret ?? "";
	const users = loginEnabled && login.local?.enabled ? (login.local.allowedUsers ?? []) : [];
	const hashes = new Set(getHashes());

	// The same rule as NodeCG's local login: a password is stored either as it
	// is or as `<algorithm>:<hex HMAC keyed with sessionSecret>`.
	const checkPassword = (username: unknown, password: unknown): boolean => {
		if (typeof username !== "string" || typeof password !== "string") return false;
		const user = users.find((candidate) => candidate.username === username);
		if (!user) return false;
		const match = /^([^:]+):(.+)$/.exec(user.password);
		if (match && hashes.has(match[1]!)) {
			const actual = createHmac(match[1]!, secret).update(password, "utf8").digest("hex");
			return safeEqual(actual, match[2]!);
		}
		return safeEqual(password, user.password);
	};

	return {
		hasToken: token !== "",
		loginEnabled,
		hasUsers: loginEnabled && Boolean(login.local?.enabled),
		open: token === "" && !loginEnabled,
		checkToken: (provided) => matches(provided, token),
		checkPassword,
		ws: {
			get hasToken() {
				return wsToken !== "" || team.hasGroupKeys();
			},
			// A group's key means someone drew a line; an open socket would
			// step over it, so from then on a key is asked for.
			get open() {
				return wsToken === "" && !loginEnabled && !team.hasGroupKeys();
			},
			signIn({ token: presented, username, password }) {
				if (presented !== undefined) {
					if (matches(presented, wsToken)) return EVERYTHING;
					const key = typeof presented === "string" ? presented.trim() : "";
					const group = key ? team.findGroup(key) : undefined;
					if (!group) return undefined;
					return {
						user: null,
						group,
						outs: () => team.groupOuts(group.id) ?? [],
						valid: () => team.findGroup(key)?.id === group.id,
					};
				}
				if (typeof username !== "string" || typeof password !== "string" || !loginEnabled) return undefined;
				if (!checkPassword(username, password) && !team.verifyUser(username, password)) return undefined;
				return {
					user: username,
					group: null,
					outs: () => {
						const outs = team.outsOf(username);
						return outs === "all" ? null : outs;
					},
					valid: () => team.roleOf(username) !== undefined,
				};
			},
		},
	};
}

export function extractToken(req: {
	headers: Record<string, string | string[] | undefined>;
	query?: Record<string, unknown>;
}): string | undefined {
	const header = req.headers["authorization"];
	const authHeader = Array.isArray(header) ? header[0] : header;
	if (authHeader?.toLowerCase().startsWith("bearer ")) {
		return authHeader.slice(7).trim();
	}
	for (const name of ["x-api-token", "x-notgt-token", "x-nodecg-token"]) {
		const value = req.headers[name];
		if (typeof value === "string" && value) return value;
		if (Array.isArray(value) && value[0]) return value[0];
	}
	const queryToken = req.query?.["token"] ?? req.query?.["key"];
	if (typeof queryToken === "string" && queryToken) return queryToken;
	return undefined;
}

/**
 * Guards `/api/*`.
 *
 * - `apiToken` configured  -> a request that presents it is let in.
 * - NodeCG login enabled   -> so is a request from a signed-in operator (the
 *   session cookie of the dashboard, or NodeCG's own `?key=`). With no
 *   `apiToken` that is the only way in: the login must not leave the API open
 *   behind its back.
 * - neither configured     -> open (a loud warning is logged at boot). Only
 *   acceptable when the endpoint is not reachable from untrusted networks or
 *   when Traefik terminates Basic Auth in front of it.
 * - `allowUnauthenticatedApi: true` silences the warning and keeps it open.
 */
export function createApiAuth(nodecg: ServerAPI, access: Access) {
	const config = (nodecg.bundleConfig ?? {}) as BundleConfig;
	const healthPath = "/health";
	const sessionCheck = nodecg.util.authCheck as unknown as Handler;
	let warned = false;

	const unauthorized = (res: ApiResponse): void => {
		res.status(401).json({
			error: "unauthorized",
			message: access.hasToken
				? "Missing or invalid API token. Send `Authorization: Bearer <token>`, `X-API-Token: <token>` or `?token=<token>`."
				: "Sign in to the dashboard first, or set `apiToken` in bundles/notGT/cfg/notGT.json and send it as `Authorization: Bearer <token>`.",
		});
	};

	return (req: ApiRequest, res: ApiResponse, next: NextFn): void => {
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}

		if (access.open) {
			if (!config.allowUnauthenticatedApi && !warned) {
				warned = true;
				nodecg.log.warn(
					"The notGT API has no `apiToken` configured and is therefore OPEN. " +
						"Set `apiToken` in bundles/notGT/cfg/notGT.json (or put the " +
						"whole subdomain behind Traefik Basic Auth) before exposing it.",
				);
			}
			next();
			return;
		}

		// Health checks stay open so uptime probes do not need the secret.
		if (req.path === healthPath && req.method === "GET") {
			next();
			return;
		}

		if (access.checkToken(extractToken(req))) {
			next();
			return;
		}

		if (access.loginEnabled && !isCrossSite(req)) {
			// NodeCG's check answers a stranger with a redirect to the sign-in
			// page. An API client gets a 401 it can read instead.
			const guarded = res as ApiResponse & { redirect: unknown };
			const redirect = guarded.redirect;
			guarded.redirect = () => {
				guarded.redirect = redirect;
				// The sign-in page comes back to where the operator was going;
				// an API address is not such a place.
				delete (req as { session?: { returnTo?: string } }).session?.returnTo;
				unauthorized(res);
			};
			sessionCheck(req, res, (err) => {
				guarded.redirect = redirect;
				next(err);
			});
			return;
		}

		unauthorized(res);
	};
}

/**
 * A page of another site can make the browser of a signed-in operator send a
 * request here, session cookie and all. The session is therefore only good for
 * requests from our own pages; everything else brings the token. A browser
 * names where a request comes from, a script (which has no cookie to abuse)
 * does not.
 */
export function isCrossSite(req: ApiRequest): boolean {
	const header = (name: string): string | undefined => {
		const value = req.headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const site = header("sec-fetch-site");
	if (site) return site !== "same-origin" && site !== "none";
	const origin = header("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host !== header("host");
	} catch {
		return true;
	}
}

/** Permissive CORS for `/api`, so browser-based integrations can poll state. */
export function corsHeaders(
	_req: ApiRequest,
	res: ApiResponse,
	next: NextFn,
): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	res.setHeader(
		"Access-Control-Allow-Headers",
		"Content-Type,Authorization,X-API-Token,X-NotGT-Token",
	);
	res.setHeader("Cache-Control", "no-store");
	next();
}
