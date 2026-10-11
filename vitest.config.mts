import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		env: {
			test: "true",
			NODECG_TEST: "true",
			// notGT switches the sign-in on by default; NodeCG's own suites were
			// written for a server that is open unless a test configures a login.
			NOTGT_LOGIN: "off",
		},
		coverage: {
			include: ["workspaces/*/src"],
			exclude: ["workspaces/nodecg/src/client"],
		},
		maxWorkers: "50%",
		projects: [
			{
				test: {
					name: "unit",
					dir: "workspaces/nodecg/src",
				},
			},
			{
				test: {
					name: "e2e-legacy",
					dir: "workspaces/nodecg/test/legacy-mode",
					testTimeout: 15_000,
				},
			},
			{
				test: {
					name: "e2e-installed",
					dir: "workspaces/nodecg/test/installed-mode",
					testTimeout: 15_000,
				},
			},
			"workspaces/cli",
			"workspaces/database-adapter-sqlite-legacy",
			"workspaces/database-adapter-types",
			"workspaces/internal-util",
		],
	},
});
