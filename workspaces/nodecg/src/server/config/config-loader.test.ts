import { expect, test } from "vitest";

import { testDirPath } from "../../../test/helpers/test-dir-path";
import { loadConfig, loginFromEnv, loginIsOff } from "./loader";

test("should throw an error when the config file is not valid JSON", () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidJSON.json"),
		),
	).toThrow(/^JSON Error in/);
});

test('should validate the "login" object when "login.enabled" is "true"', () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidLogin.json"),
		),
	).toThrow('"login.sessionSecret" must be a string');
});

test('should validate the "login.steam" object when "login.steam.enabled" is "true"', () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidSteam.json"),
		),
	).toThrow('"login.steam.apiKey" must be a string');
});

test('should validate the "login.twitch" object when "login.twitch.enabled" is "true"', () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidTwitch.json"),
		),
	).toThrow('"login.twitch.clientID" must be a string');
});

test('should validate the "login.discord" object when "login.discord.enabled" is "true"', () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidDiscord.json"),
		),
	).toThrow('"login.discord.clientID" must be a string');
});

test('should validate the "ssl" object when "ssl.enabled" is "true"', () => {
	expect(
		loadConfig.bind(
			loadConfig,
			testDirPath("fixtures/nodecg-core/cfg/invalidSSL.json"),
		),
	).toThrow('"ssl.keyPath" must be a string');
});

test("should load defaults when the config file does not exist", () => {
	const result = loadConfig(testDirPath("fixtures/nodecg-core/cfg"));
	expect(result.config.host).toBe("0.0.0.0");
	expect(result.config.port).toBe(9090);
});

test("should not have any whitelisted nor blacklisted bundles by default", () => {
	const result = loadConfig(testDirPath("fixtures/nodecg-core/cfg"));
	expect(result.config.bundles.enabled).toBe(null);
	expect(result.config.bundles.disabled).toBe(null);
});

test("should support YAML configs", () => {
	const result = loadConfig(testDirPath("fixtures/nodecg-core/cfg-yaml"));
	expect(result.config.host).toBe("yaml-config");
});

test("should support CommonJS configs", () => {
	const result = loadConfig(testDirPath("fixtures/nodecg-core/cfg-js"));
	expect(result.config.host).toBe("js-config");
});

test("should switch the sign-in on by default, with no operator of its own", () => {
	expect(loginFromEnv({})).toBeUndefined();
	expect(
		loginFromEnv({ NOTGT_LOGIN_USER: "", NOTGT_LOGIN_PASSWORD: "" }),
	).toBeUndefined();
	const { config } = loadConfig(testDirPath("fixtures/nodecg-core/cfg"), {});
	expect(config.login.enabled).toBe(true);
	expect(config.login.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
	// The users are the bundle's to keep: none come from here.
	expect(config.login.local).toEqual({ enabled: true, allowedUsers: [] });
});

test("should leave the sign-in off when NOTGT_LOGIN says so", () => {
	for (const value of ["off", "OFF", "false", "0", "no"]) {
		expect(loginIsOff({ NOTGT_LOGIN: value })).toBe(true);
	}

	expect(loginIsOff({})).toBe(false);
	expect(loginIsOff({ NOTGT_LOGIN: "on" })).toBe(false);
	const { config } = loadConfig(testDirPath("fixtures/nodecg-core/cfg"), {
		NOTGT_LOGIN: "off",
		NOTGT_LOGIN_USER: "operator",
		NOTGT_LOGIN_PASSWORD: "s3cret",
	});
	expect(config.login.enabled).toBe(false);
});

test("should leave the sign-in off when the config file switches it off", () => {
	const off = testDirPath("fixtures/nodecg-core/cfg/loginOff.json");
	expect(loadConfig(off, {}).config.login.enabled).toBe(false);
	// …unless an operator is then named in the environment.
	const named = loadConfig(off, {
		NOTGT_LOGIN_USER: "operator",
		NOTGT_LOGIN_PASSWORD: "s3cret",
	});
	expect(named.config.login.local?.allowedUsers).toEqual([
		{ username: "operator", password: "s3cret" },
	]);
});

test("should switch on the local login from NOTGT_LOGIN_USER and NOTGT_LOGIN_PASSWORD", () => {
	const { config, filteredConfig } = loadConfig(
		testDirPath("fixtures/nodecg-core/cfg"),
		{ NOTGT_LOGIN_USER: "operator", NOTGT_LOGIN_PASSWORD: "s3cret" },
	);
	expect(config.login.enabled).toBe(true);
	expect(config.login.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
	expect(config.login.local).toEqual({
		enabled: true,
		allowedUsers: [{ username: "operator", password: "s3cret" }],
	});
	// What the browser is told must not carry the password.
	expect(filteredConfig.login).toEqual({
		enabled: true,
		local: { enabled: true },
	});
});

test("should take the session secret from NOTGT_SESSION_SECRET when it is set", () => {
	const login = loginFromEnv({
		NOTGT_LOGIN_USER: "operator",
		NOTGT_LOGIN_PASSWORD: "s3cret",
		NOTGT_SESSION_SECRET: "fixed",
	});
	expect(login?.sessionSecret).toBe("fixed");
});

test("should refuse half a login in the environment", () => {
	expect(() => loginFromEnv({ NOTGT_LOGIN_USER: "operator" })).toThrow(
		"NOTGT_LOGIN_USER and NOTGT_LOGIN_PASSWORD must be set together",
	);
	expect(() => loginFromEnv({ NOTGT_LOGIN_PASSWORD: "s3cret" })).toThrow(
		"NOTGT_LOGIN_USER and NOTGT_LOGIN_PASSWORD must be set together",
	);
});

test("should prefer a login enabled in the config file to the environment", () => {
	const { config } = loadConfig(
		testDirPath("fixtures/nodecg-core/cfg/nodecg-login.json"),
		{ NOTGT_LOGIN_USER: "operator", NOTGT_LOGIN_PASSWORD: "s3cret" },
	);
	expect(config.login.sessionSecret).toBe("supersecret");
	expect(config.login.local?.allowedUsers.map((user) => user.username)).toEqual(
		["admin", "other_admin"],
	);
});
