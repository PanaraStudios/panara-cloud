// Bundles the agent into self-contained ESM files for the production image
// (dist/index.mjs, dist/panel-setup.mjs). Native add-ons are optional in
// their packages (ssh2 falls back to pure JS), so they stay external.
import { build } from "esbuild";

await build({
	entryPoints: {
		index: "src/index.ts",
		"panel-setup": "src/panelSetup.ts",
	},
	outdir: "dist",
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	target: "node24",
	format: "esm",
	sourcemap: true,
	external: ["*.node", "cpu-features", "bufferutil", "utf-8-validate"],
	// CommonJS dependencies call require() for Node built-ins and read
	// __dirname/__filename.
	banner: {
		js: [
			'import { createRequire as __pcCreateRequire } from "node:module";',
			'import { dirname as __pcDirname } from "node:path";',
			'import { fileURLToPath as __pcFileURLToPath } from "node:url";',
			"const require = __pcCreateRequire(import.meta.url);",
			"const __filename = __pcFileURLToPath(import.meta.url);",
			"const __dirname = __pcDirname(__filename);",
		].join(" "),
	},
	logLevel: "info",
});
