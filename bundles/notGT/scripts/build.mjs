#!/usr/bin/env node
/**
 * notGT build pipeline.
 *
 *  - `src/extension/**.ts`  -> `extension/index.js`            (CommonJS, bundled by esbuild)
 *  - `src/dashboard/**.tsx` -> `dashboard/assets/*.js`         (ES modules, bundled by Vite)
 *  - `src/graphics/**.ts`   -> `graphics/assets/*.js`          (ES modules, bundled by Vite)
 *
 * Everything is bundled into a single file per entry, so nothing has to be
 * resolved at runtime by the browser. That keeps the OBS/CEF side free of
 * import maps / bare specifier problems.
 */
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build as viteBuild } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.resolve(here, "..");
const watch = process.argv.includes("--watch");

const SRC = (...p) => path.join(bundleDir, "src", ...p);

async function buildExtension() {
	const options = {
		entryPoints: [SRC("extension", "index.ts")],
		outfile: path.join(bundleDir, "extension", "index.js"),
		bundle: true,
		platform: "node",
		target: "node20",
		format: "cjs",
		sourcemap: true,
		logLevel: "info",
		// NodeCG's own api instance is passed in by the loader; nothing to require.
		external: [],
	};

	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
		console.log("[notGT] watching extension (esbuild)");
	} else {
		await esbuild.build(options);
	}
}

function browserConfig(kind, entry) {
	return {
		root: bundleDir,
		configFile: false,
		envFile: false,
		plugins: [react()],
		define: {
			"process.env.NODE_ENV": JSON.stringify(
				watch ? "development" : "production",
			),
		},
		build: {
			outDir: path.join(bundleDir, kind, "assets"),
			emptyOutDir: true,
			target: "es2020",
			minify: !watch,
			sourcemap: true,
			watch: watch ? {} : null,
			lib: {
				entry,
				formats: ["es"],
				fileName: (_format, name) => `${name}.js`,
			},
			rollupOptions: {
				output: { assetFileNames: "[name][extname]" },
			},
		},
	};
}

const dashboardEntries = {
	control: SRC("dashboard", "control.tsx"),
	titles: SRC("dashboard", "titles.tsx"),
	editor: SRC("dashboard", "editor.tsx"),
};

const graphicsEntries = {
	out: SRC("graphics", "out.ts"),
};

await buildExtension();
await viteBuild(browserConfig("dashboard", dashboardEntries));
await viteBuild(browserConfig("graphics", graphicsEntries));

if (!watch) {
	console.log("[notGT] build complete");
} else {
	console.log("[notGT] watching dashboard + graphics (vite)");
}
