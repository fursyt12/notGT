import { timingSafeEqual } from "node:crypto";

import type { BundleConfig, ServerAPI } from "./store";

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

function extractToken(req: ApiRequest): string | undefined {
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
 * - `apiToken` configured  -> every request must present it.
 * - no token configured    -> open (a loud warning is logged at boot). Only
 *   acceptable when the endpoint is not reachable from untrusted networks or
 *   when Traefik terminates Basic Auth in front of it.
 * - `allowUnauthenticatedApi: true` silences the warning and keeps it open.
 */
export function createApiAuth(nodecg: ServerAPI) {
	const config = (nodecg.bundleConfig ?? {}) as BundleConfig;
	const token = (config.apiToken ?? "").trim();
	const healthPath = "/health";
	let warned = false;

	return (req: ApiRequest, res: ApiResponse, next: NextFn): void => {
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}

		if (!token) {
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

		const provided = extractToken(req);
		if (provided && safeEqual(provided, token)) {
			next();
			return;
		}

		res.status(401).json({
			error: "unauthorized",
			message:
				"Missing or invalid API token. Send `Authorization: Bearer <token>`, `X-API-Token: <token>` or `?token=<token>`.",
		});
	};
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
