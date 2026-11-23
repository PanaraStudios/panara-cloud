// Bundles the agent into self-contained files for the production image:
//   dist/index.mjs          the agent
//   dist/panel-setup.mjs    the installer's panel-setup step
//   dist/install.mjs        create-admin, reset-password, setup-link
//                           (packages/backend/scripts/install.mjs)
//   dist/migrate-fetch.mjs  fetches the migrate image's deploy files for
//                           callers that still run `migrate` in this image
//   dist/convex-cli.cjs     the Convex CLI, for the panel backup's
//                           `convex export`
// Native add-ons are optional in their packages (ssh2 falls back to pure
// JS), so they stay external.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const shared = {
	bundle: true,
	platform: "node",
	target: "node24",
	logLevel: "info",
};

await build({
	...shared,
	entryPoints: {
		index: "src/index.ts",
		"panel-setup": "src/panelSetup.ts",
		install: "../../packages/backend/scripts/install.mjs",
		"migrate-fetch": "src/migrate/main.ts",
	},
	outdir: "dist",
	outExtension: { ".js": ".mjs" },
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
});

// The CLI loads esbuild and prettier when it starts but only bundles and
// formats code for deploys and codegen, which run from the migrate image;
// `convex export` never calls them. They are replaced by stand-ins that
// throw if called, which keeps their 20 MB (and esbuild's native binary)
// out of the agent image.
const notInAgentImage = {
	name: "not-in-agent-image",
	setup(context) {
		context.onResolve({ filter: /^(esbuild|prettier|fsevents)$/ }, (args) => ({
			path: args.path,
			namespace: "not-in-agent-image",
		}));
		context.onLoad(
			{ filter: /.*/, namespace: "not-in-agent-image" },
			(args) => ({
				loader: "js",
				contents: `const fail = () => { throw new Error(${JSON.stringify(`${args.path} is not in the agent image; deploys run from panara-cloud-migrate`)}); };
module.exports = new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : fail) });`,
			}),
		);
	},
};

const convexPackage = dirname(
	createRequire(import.meta.url).resolve("convex/package.json"),
);
await build({
	...shared,
	entryPoints: [join(convexPackage, "dist", "cli.bundle.cjs")],
	outfile: "dist/convex-cli.cjs",
	format: "cjs",
	plugins: [notInAgentImage],
});
