// Cuts the functions deploy tree of the migrate image (a `pnpm deploy` of
// @panara-cloud/backend, about 400 MB) down to the files `convex deploy`
// reads: the functions source, every file esbuild loads while bundling them
// and their components, every package.json and link for module resolution,
// and the Convex CLI with its own dependencies.
//
//   node prune-functions.mjs <deploy dir>
//
// The files esbuild loads are recorded from a real bundle of the tree
// (`convex deploy --debug-bundle-path`, which bundles everything and stops
// before contacting the backend). After pruning, the tree is bundled again
// and the build fails unless every esbuild output is the same as before,
// so a file the bundle needs can never be dropped silently. Chunk file names
// are hashes that also cover which files exist, so they are compared with
// the names masked; source maps are left out of the comparison.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const work = mkdtempSync(join(tmpdir(), "prune-functions-"));
const hook = join(work, "record.cjs");

// Loaded into the CLI with --require: wraps esbuild so every build also
// reports the files it read (metafile) and what it wrote.
writeFileSync(
	hook,
	`const Module = require("module");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const out = process.env.PRUNE_RECORD;
const record = (options, result) => {
	const dir = options.absWorkingDir || process.cwd();
	const inputs = Object.keys(result.metafile.inputs).map((file) => path.resolve(dir, file));
	const outputs = (result.outputFiles || [])
		.filter((file) => !file.path.endsWith(".map"))
		.map((file) => crypto.createHash("sha256").update(file.text.replace(/\\b[A-Z0-9]{8}\\.js\\b/g, "CHUNK.js")).digest("hex"));
	fs.appendFileSync(out, JSON.stringify({ inputs, outputs }) + "\\n");
};
const load = Module._load;
let wrapped;
Module._load = function (request) {
	const loaded = load.apply(this, arguments);
	if (request !== "esbuild") return loaded;
	wrapped ??= {
		...loaded,
		build: async (options) => {
			const result = await loaded.build({ ...options, metafile: true });
			record(options, result);
			return result;
		},
		buildSync: (options) => {
			const result = loaded.buildSync({ ...options, metafile: true });
			record(options, result);
			return result;
		},
	};
	return wrapped;
};
`,
);

const requireFrom = (dir) => createRequire(join(dir, "noop.js"));
const packageDir = (name, from) =>
	realpathSync(dirname(requireFrom(from).resolve(`${name}/package.json`)));
const convexDir = packageDir("convex", root);
const cli = join(convexDir, "bin", "main.js");

const bundle = (name) => {
	const record = join(work, `${name}.jsonl`);
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"deploy",
			"--typecheck",
			"disable",
			"--codegen",
			"disable",
			"--debug-bundle-path",
			join(work, name),
		],
		{
			cwd: root,
			stdio: ["ignore", "ignore", "inherit"],
			env: {
				...process.env,
				NODE_OPTIONS: `--require=${hook}`,
				PRUNE_RECORD: record,
				CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:9",
				CONVEX_SELF_HOSTED_ADMIN_KEY: "offline-bundle",
				CONVEX_DEPLOYMENT: "",
				CONVEX_DEPLOY_KEY: "",
			},
		},
	);
	if (result.status !== 0) {
		throw new Error(`Bundling the functions (${name}) failed`);
	}
	const builds = readFileSync(record, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	if (builds.length === 0) throw new Error("No esbuild build was recorded");
	return {
		inputs: new Set(builds.flatMap((build) => build.inputs)),
		outputs: builds.flatMap((build) => build.outputs).sort(),
	};
};

const walk = (dir, visit) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		visit(path, entry);
		if (entry.isDirectory()) walk(path, visit);
	}
};

const before = bundle("before");

const keep = new Set([join(root, "package.json")]);
for (const file of before.inputs)
	if (file.startsWith(root + sep)) keep.add(file);
for (const dir of ["convex", "scripts"]) {
	walk(join(root, dir), (path, entry) => {
		if (entry.isFile()) keep.add(path);
	});
}
walk(join(root, "node_modules"), (path, entry) => {
	if (entry.isFile() && entry.name === "package.json") keep.add(path);
});
// The CLI loads esbuild, prettier and ws when it starts, and runs the
// esbuild binary of the platform package (the copy esbuild's install step
// leaves in its own bin/ is never used by the API).
const esbuildDir = packageDir("esbuild", convexDir);
const cliPackages = [
	convexDir,
	esbuildDir,
	packageDir("prettier", convexDir),
	packageDir("ws", convexDir),
	...readdirSync(join(esbuildDir, ".."))
		.filter((name) => name === "@esbuild")
		.flatMap((scope) =>
			readdirSync(join(esbuildDir, "..", scope)).map((name) =>
				realpathSync(join(esbuildDir, "..", scope, name)),
			),
		),
];
const unused = /\.(map|d\.ts|d\.cts|d\.mts)$/;
for (const dir of cliPackages) {
	walk(dir, (path, entry) => {
		if (entry.isFile() && !unused.test(entry.name)) keep.add(path);
	});
}
keep.delete(join(esbuildDir, "bin", "esbuild"));

const size = () => {
	let bytes = 0;
	walk(root, (path, entry) => {
		if (entry.isFile()) bytes += lstatSync(path).size;
	});
	return Math.round(bytes / 1e6);
};
const sizeBefore = size();
walk(root, (path, entry) => {
	if (entry.isFile() && !keep.has(path)) rmSync(path);
});
const removeEmpty = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) removeEmpty(join(dir, entry.name));
	}
	if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
};
removeEmpty(root);

const after = bundle("after");
const digest = (list) =>
	createHash("sha256").update(list.join("\n")).digest("hex");
if (
	after.outputs.length !== before.outputs.length ||
	digest(after.outputs) !== digest(before.outputs)
) {
	throw new Error(
		`The pruned tree bundles differently (${before.outputs.length} outputs before, ${after.outputs.length} after); a file it needs was removed`,
	);
}
rmSync(work, { recursive: true, force: true });
console.log(
	`Functions deploy tree: ${sizeBefore} MB -> ${size()} MB, ${after.outputs.length} bundle outputs unchanged (${relative(process.cwd(), root) || "."})`,
);
