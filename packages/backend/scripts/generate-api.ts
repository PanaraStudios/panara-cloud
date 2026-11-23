// Writes the API gateway's function list and the catalog the OpenAPI document
// and the MCP tools are built from:
//
//   pnpm --filter @panara-cloud/backend generate:api
//
// Run it after adding, removing or changing the arguments of a public Convex
// function. A new function is served by the API unless
// convex/platform/lib/apiPolicy.ts denies it.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	publicFunctions,
	renderCatalog,
	renderFunctionList,
	type SourceModule,
} from "../convex/platform/lib/apiCatalogBuild";

process.env.CONVEX_SITE_URL ??= "http://localhost";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const convexDir = join(backendDir, "convex");
const SKIPPED_DIRECTORIES = new Set(["_generated", "betterAuth"]);
const SKIPPED_FILES = new Set(["convex.config.ts", "test.setup.ts"]);

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return SKIPPED_DIRECTORIES.has(name) ? [] : sourceFiles(path);
		}
		return name.endsWith(".ts") &&
			!name.endsWith(".test.ts") &&
			!name.endsWith(".d.ts")
			? [path]
			: [];
	});

const modules: SourceModule[] = [];
for (const file of sourceFiles(convexDir)) {
	const path = relative(convexDir, file);
	if (SKIPPED_FILES.has(path)) continue;
	modules.push({
		path: path.replace(/\.ts$/, ""),
		exports: await import(file),
		source: readFileSync(file, "utf8"),
	});
}

const functions = publicFunctions(modules);
writeFileSync(
	join(convexDir, "platform/lib/apiFunctions.ts"),
	renderFunctionList(functions),
);
writeFileSync(join(backendDir, "api/catalog.json"), renderCatalog(functions));

const served = functions.filter((fn) => fn.denied === null).length;
console.log(
	`${functions.length} public functions: ${served} served, ${functions.length - served} denied`,
);
