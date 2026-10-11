import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { cosmiconfigSync as cosmiconfig } from "cosmiconfig";
import { klona as clone } from "klona/json";

import type { NodeCG } from "../../types/nodecg";
import { nodecgConfigSchema } from "../../types/nodecg-config-schema";

/**
 * notGT: the sign-in is on unless someone switched it off.
 *
 * Who signs in comes from one of three places, the first that speaks:
 *
 *  1. a `login` block in the config file. `enabled: true` is NodeCG's own
 *     login, as configured; `enabled: false` switches the sign-in off (this is
 *     what the launcher's «Отключить» writes);
 *  2. `NOTGT_LOGIN=off` in the environment — off; or `NOTGT_LOGIN_USER` and
 *     `NOTGT_LOGIN_PASSWORD` — the local login for that one operator, for a
 *     container whose whole configuration is a few lines of `.env`;
 *  3. nothing at all — the local login with no operator of its own. The notGT
 *     bundle then keeps the users, starting with a default administrator
 *     (`admin` / `admin`) that it asks to be given a real password.
 *
 * The sessions are salted with `NOTGT_SESSION_SECRET`, or with a secret made
 * up for this run when it is not set.
 */
const sessionSecret = (env: NodeJS.ProcessEnv): string =>
	env.NOTGT_SESSION_SECRET?.trim() || crypto.randomBytes(32).toString("hex");

export const loginIsOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
	["off", "false", "no", "0"].includes(
		env.NOTGT_LOGIN?.trim().toLowerCase() ?? "",
	);

export const loginFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
	const username = env.NOTGT_LOGIN_USER?.trim() ?? "";
	const password = env.NOTGT_LOGIN_PASSWORD ?? "";
	if (!username && !password) {
		return undefined;
	}

	// Half a login would leave the dashboard open while looking protected.
	if (!username || !password) {
		throw new Error(
			"NOTGT_LOGIN_USER and NOTGT_LOGIN_PASSWORD must be set together",
		);
	}

	return {
		enabled: true,
		sessionSecret: sessionSecret(env),
		local: {
			enabled: true,
			allowedUsers: [{ username, password }],
		},
	};
};

/** The sign-in nobody configured: on, with the users the bundle keeps. */
export const defaultLogin = (env: NodeJS.ProcessEnv = process.env) => ({
	enabled: true,
	sessionSecret: sessionSecret(env),
	local: {
		enabled: true,
		allowedUsers: [],
	},
});

export const loadConfig = (
	cfgDirOrFile: string,
	env: NodeJS.ProcessEnv = process.env,
) => {
	let isFile = false;
	try {
		isFile = fs.lstatSync(cfgDirOrFile).isFile();
	} catch (error: any) {
		if (error.code !== "ENOENT") {
			throw error;
		}
	}

	const cfgDir = isFile ? path.dirname(cfgDirOrFile) : cfgDirOrFile;
	const cc = cosmiconfig("nodecg", {
		searchPlaces: isFile
			? [path.basename(cfgDirOrFile)]
			: [
					"nodecg.json",
					"nodecg.yaml",
					"nodecg.yml",
					"nodecg.js",
					"nodecg.config.js",
				],
		stopDir: cfgDir,
	});
	const result = cc.search(cfgDir);
	const fileCfg = result?.config ?? {};
	let userCfg = fileCfg;
	if (fileCfg?.login === undefined && !loginIsOff(env)) {
		userCfg = { ...fileCfg, login: loginFromEnv(env) ?? defaultLogin(env) };
	} else if (fileCfg?.login?.enabled === false && !loginIsOff(env)) {
		// The file says "off"; an operator named in the environment is a
		// later, more deliberate word.
		const envLogin = loginFromEnv(env);
		if (envLogin) {
			userCfg = { ...fileCfg, login: envLogin };
		}
	}

	if (userCfg?.bundles?.enabled && userCfg?.bundles?.disabled) {
		throw new Error(
			"nodecg.json may only contain EITHER bundles.enabled OR bundles.disabled, not both.",
		);
	} else if (!userCfg) {
		console.info("[nodecg] No config found, using defaults.");
	}

	const parseResult = nodecgConfigSchema.safeParse(userCfg);

	if (!parseResult.success) {
		console.error(
			"[nodecg] Config invalid:",
			parseResult.error.errors[0]?.message,
		);
		throw new Error(parseResult.error.errors[0]?.message);
	}

	const config = parseResult.data;

	// Create the filtered config
	const filteredConfig: NodeCG.FilteredConfig = {
		host: config.host,
		port: config.port,
		baseURL: config.baseURL,
		logging: {
			console: {
				enabled: config.logging.console.enabled,
				level: config.logging.console.level,
				timestamps: config.logging.console.timestamps,
				replicants: config.logging.console.replicants,
			},
			file: {
				enabled: config.logging.file.enabled,
				level: config.logging.file.level,
				timestamps: config.logging.file.timestamps,
				replicants: config.logging.file.replicants,
			},
		},
		login: {
			enabled: config.login.enabled,
		},
		sentry: {
			enabled: config.sentry.enabled,
			dsn: config.sentry.enabled ? config.sentry.dsn : undefined,
		},
	};

	if (config.login.enabled && config.login.steam) {
		filteredConfig.login.steam = {
			enabled: config.login.steam.enabled,
		};
	}

	if (config.login.enabled && config.login.twitch) {
		filteredConfig.login.twitch = {
			enabled: config.login.twitch.enabled,
			clientID: config.login.twitch.enabled
				? config.login.twitch.clientID
				: undefined,
			scope: config.login.twitch.enabled
				? config.login.twitch.scope
				: undefined,
		};
	}

	if (config.login.enabled && config.login.local) {
		filteredConfig.login.local = {
			enabled: config.login.local.enabled,
		};
	}

	if (config.login.enabled && config.login.discord) {
		filteredConfig.login.discord = {
			enabled: config.login.discord.enabled,
			clientID: config.login.discord.enabled
				? config.login.discord.clientID
				: undefined,
			scope: config.login.discord.enabled
				? config.login.discord.scope
				: undefined,
		};
	}

	if (config.ssl) {
		filteredConfig.ssl = {
			enabled: config.ssl.enabled,
		};
	}

	return {
		config: clone(config),
		filteredConfig: clone(filteredConfig),
	};
};
