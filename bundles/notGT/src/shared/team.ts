/**
 * The team: who signs in, what they see, and the keys that are nobody's own.
 *
 *  - a **user** is an administrator or a member of one or more groups;
 *  - a **group** (VJ, Streamer 1, …) is a set of outs, with the keys that let
 *    an integration — a Companion — drive those outs and no others;
 *  - an **out** has a key of its own: the one in its OBS link.
 *
 * These are the shapes that travel between the extension and the Team panel.
 * Passwords never do.
 */
import { BUNDLE_NAME } from "./types";

export type TeamRole = "admin" | "member";

export interface TeamUserInfo {
	id: string;
	username: string;
	role: TeamRole;
	/** Ids of the groups a member belongs to. */
	groups: string[];
	/** Listed in the server's own config (launcher, `.env`): always an administrator, not edited here. */
	builtin: boolean;
	/** Still has the password a new installation starts with. */
	defaultPassword: boolean;
}

export interface TeamGroupKey {
	id: string;
	label: string;
	key: string;
	createdAt: number;
}

export interface TeamGroupInfo {
	id: string;
	name: string;
	/** Ids of the outs the group works with. */
	outs: string[];
	/** Keys of the WebSocket API that reach these outs only. */
	keys: TeamGroupKey[];
}

/** Everything an administrator manages. */
export interface TeamState {
	users: TeamUserInfo[];
	groups: TeamGroupInfo[];
	/** outId -> the key of its OBS link. */
	outKeys: Record<string, string>;
}

/** What the signed-in operator is and may see. */
export interface TeamMe {
	/** The sign-in is switched on. Without it everyone is an administrator. */
	login: boolean;
	username: string | null;
	role: TeamRole;
	outs: "all" | string[];
	groups: Array<{ id: string; name: string }>;
	/** Keys of the OBS links of the outs this operator sees. */
	outKeys: Record<string, string>;
	/** This operator still signs in with the password everybody knows. */
	defaultPassword: boolean;
}

export const TEAM_BASE = `/bundles/${BUNDLE_NAME}/team`;

/** Shortest password an administrator can give a user. */
export const MIN_PASSWORD = 6;

/**
 * The administrator a new installation starts with. It exists so that there is
 * a way in the first time; the Team panel asks for a real password until it
 * has one.
 */
export const DEFAULT_ADMIN = { username: "admin", password: "admin" } as const;
