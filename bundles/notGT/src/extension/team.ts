import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	DEFAULT_ADMIN,
	MIN_PASSWORD,
	type TeamGroupInfo,
	type TeamMe,
	type TeamRole,
	type TeamState,
	type TeamUserInfo,
} from "../shared/team";
import { BUNDLE_NAME, newId, REPLICANTS } from "../shared/types";
import type { ServerAPI, Store } from "./store";

/**
 * The team, as kept on the server.
 *
 * It lives in a file of its own (`db/notGT-team.json`, next to NodeCG's
 * database, so it shares its volume and its backups) and deliberately not in a
 * Replicant: a Replicant is sent to every page that asks, the out pages in OBS
 * included, and this holds password hashes and keys.
 */

interface StoredUser {
	id: string;
	username: string;
	/** `scrypt:<salt>:<hash>`, both hex. */
	password: string;
	role: TeamRole;
	groups: string[];
	createdAt: number;
	/** The password is still the one a new installation starts with. */
	defaultPassword?: boolean;
}

interface StoredGroup extends TeamGroupInfo {
	createdAt: number;
}

interface TeamFile {
	version: 1;
	users: StoredUser[];
	groups: StoredGroup[];
	outKeys: Record<string, string>;
}

/** A request the team refuses, with the HTTP status that says why. */
export class TeamError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface Team {
	/** The sign-in is switched on. Without it there are no users and everyone is an administrator. */
	readonly loginEnabled: boolean;
	roleOf(username: string | null | undefined): TeamRole | undefined;
	/** The outs a user works with: `"all"` for an administrator. */
	outsOf(username: string | null | undefined): "all" | string[];
	me(username: string | null | undefined): TeamMe;
	state(): TeamState;

	verifyUser(username: string, password: string): boolean;
	hasUser(username: string): boolean;

	createUser(input: Record<string, unknown>): TeamUserInfo;
	updateUser(id: string, patch: Record<string, unknown>): TeamUserInfo;
	deleteUser(id: string): void;

	createGroup(input: Record<string, unknown>): TeamGroupInfo;
	updateGroup(id: string, patch: Record<string, unknown>): TeamGroupInfo;
	deleteGroup(id: string): void;
	addGroupKey(groupId: string, label: unknown): TeamGroupInfo;
	removeGroupKey(groupId: string, keyId: string): TeamGroupInfo;

	/**
	 * The key of an out's OBS link; made on first use. `undefined` while the
	 * sign-in is off: the out pages are open then and their links need no key.
	 */
	outKey(outId: string): string | undefined;
	regenerateOutKey(outId: string): string;
	/** The out an OBS key opens. */
	findOut(key: string): string | undefined;
	/** The group a WebSocket key belongs to. */
	findGroup(key: string): { id: string; name: string } | undefined;
	/** The outs of a group that exist, or `undefined` when the group is gone. */
	groupOuts(groupId: string): string[] | undefined;
	hasGroupKeys(): boolean;
	/** The default administrator, while its password is still the default one. */
	defaultSignIn(): { username: string; password: string } | undefined;

	onChange(listener: () => void): void;
}

const newKey = (prefix: string): string => `${prefix}_${randomBytes(24).toString("base64url")}`;

function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function passwordMatches(password: string, stored: string): boolean {
	const [scheme, salt, hash] = stored.split(":");
	if (scheme !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "hex");
	const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
	return timingSafeEqual(actual, expected);
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const idList = (value: unknown): string[] =>
	Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];

export function createTeam(nodecg: ServerAPI, store: Store, file: string): Team {
	const log = nodecg.log;
	const login = (
		nodecg.config as unknown as {
			login?: { enabled?: boolean; local?: { enabled?: boolean; allowedUsers?: Array<{ username: string }> } };
		}
	).login;
	const loginEnabled = Boolean(login?.enabled);
	/** The operators of the server's own config: the administrators nobody here can remove. */
	const builtin = loginEnabled && login?.local?.enabled ? (login.local.allowedUsers ?? []).map((u) => u.username) : [];

	const revision = nodecg.Replicant<number>(REPLICANTS.teamRevision, BUNDLE_NAME, {
		defaultValue: 0,
		persistent: false,
	});
	const listeners = new Set<() => void>();

	let data: TeamFile = { version: 1, users: [], groups: [], outKeys: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TeamFile>;
		data = {
			version: 1,
			users: Array.isArray(parsed.users) ? parsed.users : [],
			groups: Array.isArray(parsed.groups) ? parsed.groups : [],
			outKeys: parsed.outKeys && typeof parsed.outKeys === "object" ? parsed.outKeys : {},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Never overwrite a file we could not read: it is the only copy.
			const aside = `${file}.unreadable-${Date.now()}`;
			log.error("The team file %s could not be read (%s); kept as %s", file, (error as Error).message, aside);
			try {
				fs.renameSync(file, aside);
			} catch {
				// Read-only disk: the team stays empty for this run.
			}
		}
	}

	const save = (): void => {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
			fs.renameSync(tmp, file);
		} catch (error) {
			log.error("The team could not be saved to %s: %s", file, (error as Error).message);
			throw new TeamError(500, "not_saved", "The change could not be written to disk");
		}
		revision.value = (revision.value ?? 0) + 1;
		for (const listener of listeners) listener();
	};

	const outExists = (outId: string): boolean => Boolean(store.getOut(outId));
	const publicUser = (user: StoredUser): TeamUserInfo => ({
		id: user.id,
		username: user.username,
		role: user.role,
		groups: user.groups.filter((id) => data.groups.some((group) => group.id === id)),
		builtin: false,
		defaultPassword: Boolean(user.defaultPassword),
	});
	const publicGroup = (group: StoredGroup): TeamGroupInfo => ({
		id: group.id,
		name: group.name,
		outs: group.outs.filter(outExists),
		keys: group.keys,
	});
	const findUser = (username: string): StoredUser | undefined =>
		data.users.find((user) => user.username === username);
	const userById = (id: string): StoredUser => {
		const user = data.users.find((candidate) => candidate.id === id);
		if (!user) throw new TeamError(404, "not_found", "No such user");
		return user;
	};
	const groupById = (id: string): StoredGroup => {
		const group = data.groups.find((candidate) => candidate.id === id);
		if (!group) throw new TeamError(404, "not_found", "No such group");
		return group;
	};
	const knownGroups = (ids: string[]): string[] => ids.filter((id) => data.groups.some((group) => group.id === id));

	function roleOf(username: string | null | undefined): TeamRole | undefined {
		if (!loginEnabled) return "admin";
		if (!username) return undefined;
		if (builtin.includes(username)) return "admin";
		return findUser(username)?.role;
	}

	function outsOf(username: string | null | undefined): "all" | string[] {
		const role = roleOf(username);
		if (role === "admin") return "all";
		const user = username ? findUser(username) : undefined;
		if (!user) return [];
		const outs = new Set<string>();
		for (const group of data.groups) {
			if (user.groups.includes(group.id)) for (const outId of group.outs) outs.add(outId);
		}
		return [...outs].filter(outExists);
	}

	function outKey(outId: string): string | undefined {
		if (!loginEnabled || !outExists(outId)) return undefined;
		if (!data.outKeys[outId]) {
			data.outKeys[outId] = newKey("out");
			save();
		}
		return data.outKeys[outId];
	}

	function validName(value: unknown, what: string): string {
		const name = text(value);
		if (!name) throw new TeamError(400, "bad_request", `${what} needs a name`);
		if (name.length > 64) throw new TeamError(400, "bad_request", `${what}: the name is too long`);
		return name;
	}
	function validPassword(value: unknown): string {
		if (typeof value !== "string" || value.length < MIN_PASSWORD) {
			throw new TeamError(400, "bad_request", `A password needs at least ${MIN_PASSWORD} characters`);
		}
		return value;
	}
	const validRole = (value: unknown): TeamRole => (value === "admin" ? "admin" : "member");
	/** Refuses to take away the last administrator: nobody could manage the team after that. */
	function keepAnAdministrator(leaving: StoredUser): void {
		if (leaving.role !== "admin" || builtin.length > 0) return;
		if (!data.users.some((user) => user.role === "admin" && user.id !== leaving.id)) {
			throw new TeamError(409, "conflict", "This is the only administrator");
		}
	}

	// The way in on the first day. An installation whose sign-in is on and
	// that names no administrator anywhere gets the default one; it is told —
	// here, on the sign-in page and in the Team panel — to change the password.
	// Once the server's own config names an administrator, a default account
	// nobody gave a password to is a door left open, and it goes.
	// A disk that cannot be written must not keep the server from starting:
	// what was decided here holds for this run and is decided again next time.
	const saveIfPossible = (): void => {
		try {
			save();
		} catch {
			// Already logged by `save`.
		}
	};
	if (loginEnabled) {
		const untouched = data.users.find((user) => user.defaultPassword);
		if (builtin.length > 0) {
			if (untouched) {
				data.users = data.users.filter((user) => user !== untouched);
				saveIfPossible();
				log.info('The default administrator "%s" was removed: the server config names its own', untouched.username);
			}
		} else if (!data.users.some((user) => user.role === "admin")) {
			data.users = data.users.filter((user) => user.username !== DEFAULT_ADMIN.username);
			data.users.push({
				id: newId("user"),
				username: DEFAULT_ADMIN.username,
				password: hashPassword(DEFAULT_ADMIN.password),
				role: "admin",
				groups: [],
				createdAt: Date.now(),
				defaultPassword: true,
			});
			saveIfPossible();
		}
		if (data.users.some((user) => user.defaultPassword)) {
			log.warn(
				'The administrator signs in as "%s" with the default password "%s". Change it in the Team tab of the dashboard.',
				DEFAULT_ADMIN.username,
				DEFAULT_ADMIN.password,
			);
		}
	}

	return {
		loginEnabled,
		roleOf,
		outsOf,

		me(username) {
			const role = roleOf(username) ?? "member";
			const outs = outsOf(username);
			const user = username ? findUser(username) : undefined;
			const visible = outs === "all" ? store.listOuts().map((out) => out.id) : outs;
			const outKeys: Record<string, string> = {};
			for (const outId of visible) {
				const key = outKey(outId);
				if (key) outKeys[outId] = key;
			}
			return {
				login: loginEnabled,
				username: username ?? null,
				role,
				outs,
				groups: data.groups
					.filter((group) => role === "admin" || user?.groups.includes(group.id))
					.map((group) => ({ id: group.id, name: group.name })),
				outKeys,
				defaultPassword: Boolean(user?.defaultPassword),
			};
		},

		state() {
			const outKeys: Record<string, string> = {};
			for (const out of store.listOuts()) {
				const key = outKey(out.id);
				if (key) outKeys[out.id] = key;
			}
			return {
				users: [
					...builtin.map((username) => ({
						id: `builtin:${username}`,
						username,
						role: "admin" as const,
						groups: [],
						builtin: true,
						defaultPassword: false,
					})),
					...data.users.filter((user) => !builtin.includes(user.username)).map(publicUser),
				],
				groups: data.groups.map(publicGroup),
				outKeys,
			};
		},

		verifyUser(username, password) {
			const user = findUser(username);
			return Boolean(user) && passwordMatches(password, user!.password);
		},
		hasUser: (username) => Boolean(findUser(username)),

		createUser(input) {
			const username = validName(input["username"], "A user");
			if (findUser(username) || builtin.includes(username)) {
				throw new TeamError(409, "conflict", `There already is a user "${username}"`);
			}
			const user: StoredUser = {
				id: newId("user"),
				username,
				password: hashPassword(validPassword(input["password"])),
				role: validRole(input["role"]),
				groups: knownGroups(idList(input["groups"])),
				createdAt: Date.now(),
			};
			data.users.push(user);
			save();
			return publicUser(user);
		},
		updateUser(id, patch) {
			const user = userById(id);
			if (patch["password"] !== undefined && patch["password"] !== "") {
				user.password = hashPassword(validPassword(patch["password"]));
				delete user.defaultPassword;
			}
			if (patch["role"] !== undefined) {
				const role = validRole(patch["role"]);
				if (role !== "admin") keepAnAdministrator(user);
				user.role = role;
			}
			if (patch["groups"] !== undefined) user.groups = knownGroups(idList(patch["groups"]));
			save();
			return publicUser(user);
		},
		deleteUser(id) {
			keepAnAdministrator(userById(id));
			data.users = data.users.filter((user) => user.id !== id);
			save();
		},

		createGroup(input) {
			const group: StoredGroup = {
				id: newId("group"),
				name: validName(input["name"], "A group"),
				outs: idList(input["outs"]).filter(outExists),
				keys: [],
				createdAt: Date.now(),
			};
			data.groups.push(group);
			save();
			return publicGroup(group);
		},
		updateGroup(id, patch) {
			const group = groupById(id);
			if (patch["name"] !== undefined) group.name = validName(patch["name"], "A group");
			if (patch["outs"] !== undefined) group.outs = idList(patch["outs"]).filter(outExists);
			save();
			return publicGroup(group);
		},
		deleteGroup(id) {
			groupById(id);
			data.groups = data.groups.filter((group) => group.id !== id);
			for (const user of data.users) user.groups = user.groups.filter((groupId) => groupId !== id);
			save();
		},
		addGroupKey(groupId, label) {
			const group = groupById(groupId);
			group.keys.push({
				id: newId("key"),
				label: text(label).slice(0, 64) || `Key ${group.keys.length + 1}`,
				key: newKey("ws"),
				createdAt: Date.now(),
			});
			save();
			return publicGroup(group);
		},
		removeGroupKey(groupId, keyId) {
			const group = groupById(groupId);
			if (!group.keys.some((key) => key.id === keyId)) throw new TeamError(404, "not_found", "No such key");
			group.keys = group.keys.filter((key) => key.id !== keyId);
			save();
			return publicGroup(group);
		},

		outKey,
		regenerateOutKey(outId) {
			if (!outExists(outId)) throw new TeamError(404, "not_found", "No such out");
			if (!loginEnabled) throw new TeamError(409, "conflict", "The out pages need no key while the sign-in is off");
			data.outKeys[outId] = newKey("out");
			save();
			return data.outKeys[outId]!;
		},
		findOut(key) {
			for (const [outId, outKeyValue] of Object.entries(data.outKeys)) {
				if (outKeyValue === key) return outExists(outId) ? outId : undefined;
			}
			return undefined;
		},
		findGroup(key) {
			const group = data.groups.find((candidate) => candidate.keys.some((entry) => entry.key === key));
			return group ? { id: group.id, name: group.name } : undefined;
		},
		groupOuts(groupId) {
			const group = data.groups.find((candidate) => candidate.id === groupId);
			return group ? group.outs.filter(outExists) : undefined;
		},
		hasGroupKeys: () => data.groups.some((group) => group.keys.length > 0),
		defaultSignIn: () =>
			loginEnabled && data.users.some((user) => user.defaultPassword) ? { ...DEFAULT_ADMIN } : undefined,

		onChange(listener) {
			listeners.add(listener);
		},
	};
}
