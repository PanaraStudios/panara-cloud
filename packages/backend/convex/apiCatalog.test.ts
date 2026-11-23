/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import apiDocs from "../../../docs/api.md?raw";
import catalogJson from "../api/catalog.json";
import {
	buildCatalog,
	publicFunctions,
	renderFunctionList,
	type SourceModule,
} from "./platform/lib/apiCatalogBuild";
import { API_FUNCTIONS } from "./platform/lib/apiFunctions";
import functionListSource from "./platform/lib/apiFunctions.ts?raw";
import {
	apiName,
	convexPath,
	DENIED_FUNCTIONS,
	DENIED_MODULES,
	denyReason,
	groupOf,
	moduleOf,
} from "./platform/lib/apiPolicy";
import {
	type Catalog,
	callPath,
	inGroups,
	isDestructive,
	type JsonSchema,
	mcpTools,
	openApiDocument,
	parseGroups,
	summaryOf,
	toJsonSchema,
	toolName,
} from "./platform/lib/apiSpec";

const exportsByFile = import.meta.glob(
	[
		"./**/*.ts",
		"!./**/*.test.ts",
		"!./_generated/**",
		"!./betterAuth/**",
		"!./test.setup.ts",
		"!./convex.config.ts",
	],
	{ eager: true },
) as Record<string, Record<string, unknown>>;
const sourceByFile = import.meta.glob(
	[
		"./**/*.ts",
		"!./**/*.test.ts",
		"!./_generated/**",
		"!./betterAuth/**",
		"!./test.setup.ts",
		"!./convex.config.ts",
	],
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const modules: SourceModule[] = Object.keys(exportsByFile).map((file) => ({
	path: file.replace(/^\.\//, "").replace(/\.ts$/, ""),
	exports: exportsByFile[file],
	source: sourceByFile[file],
}));
const functions = publicFunctions(modules);
const catalog = catalogJson as Catalog;
const REGENERATE =
	"run `pnpm --filter @panara-cloud/backend generate:api` and review what it serves";

describe("every public function is classified", () => {
	test("the gateway's function list matches the code", () => {
		expect(functionListSource, REGENERATE).toBe(renderFunctionList(functions));
		expect(Object.keys(API_FUNCTIONS)).toEqual(functions.map((fn) => fn.name));
	});

	test("the catalog matches the code", () => {
		expect(catalog, REGENERATE).toEqual(buildCatalog(functions));
	});

	test("each function is either served or denied with a reason", () => {
		const served = new Set(catalog.functions.map((fn) => fn.name));
		expect(functions.length).toBeGreaterThan(500);
		for (const fn of functions) {
			const reason = denyReason(fn.name);
			expect(served.has(fn.name), fn.name).toBe(reason === null);
			if (reason !== null) expect(reason.length, fn.name).toBeGreaterThan(10);
		}
	});

	test("the deny list names only functions that exist", () => {
		const names = new Set(functions.map((fn) => fn.name));
		const paths = new Set(modules.map((module) => module.path));
		for (const name of Object.keys(DENIED_FUNCTIONS)) {
			expect(names.has(name), name).toBe(true);
			// Listed once: not also covered by its module.
			expect(
				DENIED_MODULES[moduleOf(name).replaceAll(".", "/")],
				name,
			).toBeUndefined();
		}
		for (const path of Object.keys(DENIED_MODULES)) {
			expect(paths.has(path), path).toBe(true);
			expect(
				functions.some((fn) => moduleOf(fn.name) === apiName(path)),
				path,
			).toBe(true);
		}
	});

	test("docs/api.md lists the whole deny list", () => {
		for (const path of Object.keys(DENIED_MODULES)) {
			expect(apiDocs, path).toContain(`\`${apiName(path)}.*\``);
		}
		for (const name of Object.keys(DENIED_FUNCTIONS)) {
			expect(apiDocs, name).toContain(`\`${name}\``);
		}
	});

	test("nothing served is an agent function", () => {
		for (const fn of catalog.functions) {
			const args = fn.args.type === "object" ? Object.keys(fn.args.value) : [];
			expect(args, fn.name).not.toContain("leaseId");
			expect(moduleOf(fn.name).split(".").at(-1), fn.name).not.toBe("agent");
		}
	});

	test("names map to Convex paths and back", () => {
		for (const fn of functions) {
			expect(apiName(convexPath(fn.name))).toBe(fn.name);
			expect(fn.name).toMatch(
				/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/,
			);
		}
		expect(convexPath("applications.deploy.start")).toBe(
			"applications/deploy:start",
		);
		expect(convexPath("projects.list")).toBe("projects:list");
		expect(groupOf("applications.deploy.start")).toBe("applications");
		expect(groupOf("projects.list")).toBe("projects");
	});
});

const propertyKeys = (schema: JsonSchema, keys: string[] = []): string[] => {
	for (const [name, value] of Object.entries(schema)) {
		if (name === "properties" && value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				keys.push(key);
				propertyKeys(child as JsonSchema, keys);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object") {
					propertyKeys(item as JsonSchema, keys);
				}
			}
		} else if (value && typeof value === "object") {
			propertyKeys(value as JsonSchema, keys);
		}
	}
	return keys;
};

describe("MCP tools", () => {
	const tools = mcpTools(catalog);

	test("one tool per served function, with names every client accepts", () => {
		expect(tools).toHaveLength(catalog.functions.length);
		expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
		for (const tool of tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
			expect(tool.description.length).toBeGreaterThan(5);
			expect(tool.inputSchema.type).toBe("object");
			for (const key of propertyKeys(tool.inputSchema)) {
				expect(key, tool.name).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
			}
		}
		expect(toolName("applications.deploy.start")).toBe(
			"applications_deploy_start",
		);
	});

	test("queries are read-only and removals destructive", () => {
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(byName.get("projects_list")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(byName.get("projects_remove")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(byName.get("projects_create")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
		for (const fn of catalog.functions) {
			if (fn.kind === "query") expect(isDestructive(fn), fn.name).toBe(false);
		}
	});

	test("the groups filter selects by group or module", () => {
		expect(parseGroups(" projects, applications.deploy ,")).toEqual([
			"projects",
			"applications.deploy",
		]);
		expect(parseGroups(null)).toEqual([]);
		expect(inGroups("projects.list", ["projects"])).toBe(true);
		expect(inGroups("projectsExtra.list", ["projects"])).toBe(false);
		expect(inGroups("applications.deploy.start", ["applications"])).toBe(true);
		expect(inGroups("applications.mounts.list", ["applications.deploy"])).toBe(
			false,
		);
		const some = mcpTools(catalog, ["projects", "applications.deploy"]);
		expect(some.length).toBeGreaterThan(10);
		expect(some.length).toBeLessThan(tools.length / 4);
		expect(
			some.every(
				(tool) =>
					tool.name.startsWith("projects_") ||
					tool.name.startsWith("applications_deploy_"),
			),
		).toBe(true);
		expect(mcpTools(catalog, ["nothing"])).toEqual([]);
	});
});

describe("OpenAPI document", () => {
	const document = openApiDocument(catalog);
	const paths = document.paths as Record<
		string,
		Record<string, { operationId: string; tags: string[] }>
	>;

	test("covers every served function and nothing denied", () => {
		expect(document.openapi).toBe("3.1.0");
		expect(document.info.version).toBe("1");
		for (const fn of catalog.functions) {
			const item = paths[callPath(fn.name)];
			expect(item?.post?.operationId, fn.name).toBe(fn.name);
			expect(item.post.tags).toEqual([moduleOf(fn.name)]);
			expect(Boolean(item.get), fn.name).toBe(fn.kind === "query");
		}
		for (const fn of functions) {
			if (fn.denied) expect(paths[callPath(fn.name)], fn.name).toBeUndefined();
		}
		expect(paths["/me"].get.operationId).toBe("rest.me");
	});

	test("operation ids are unique and every tag and reference resolves", () => {
		const ids = Object.values(paths).flatMap((item) =>
			Object.values(item).map((operation) => operation.operationId),
		);
		expect(new Set(ids).size).toBe(ids.length);
		const tags = new Set(document.tags.map((tag) => tag.name));
		for (const item of Object.values(paths)) {
			for (const operation of Object.values(item)) {
				for (const tag of operation.tags) expect(tags.has(tag), tag).toBe(true);
			}
		}
		const text = JSON.stringify(document);
		for (const [, ref] of text.matchAll(/"\$ref":"#\/components\/([^"]+)"/g)) {
			const [section, name] = ref.split("/");
			expect(
				(document.components as Record<string, Record<string, unknown>>)[
					section
				]?.[name],
				ref,
			).toBeDefined();
		}
		expect(document.components.securitySchemes.apiKey).toEqual({
			type: "apiKey",
			in: "header",
			name: "x-api-key",
		});
	});

	test("schemas follow the validators", () => {
		expect(
			toJsonSchema({
				type: "object",
				value: {
					organizationId: { fieldType: { type: "string" }, optional: false },
					projectId: {
						fieldType: { type: "id", tableName: "projects" },
						optional: true,
					},
					mode: {
						fieldType: {
							type: "union",
							value: [
								{ type: "literal", value: "a" },
								{ type: "literal", value: "b" },
							],
						},
						optional: true,
					},
					size: {
						fieldType: {
							type: "union",
							value: [{ type: "bigint" }, { type: "null" }],
						},
						optional: true,
					},
					labels: {
						fieldType: {
							type: "record",
							keys: { type: "string" },
							values: { fieldType: { type: "number" }, optional: false },
						},
						optional: true,
					},
				},
			}),
		).toEqual({
			type: "object",
			properties: {
				organizationId: { type: "string" },
				projectId: {
					type: "string",
					description: 'Id of a document in "projects"',
				},
				mode: { enum: ["a", "b"] },
				size: {
					anyOf: [
						{
							type: "object",
							description: expect.stringContaining("$integer"),
							properties: { $integer: { type: "string" } },
							required: ["$integer"],
							additionalProperties: false,
						},
						{ type: "null" },
					],
				},
				labels: { type: "object", additionalProperties: { type: "number" } },
			},
			required: ["organizationId"],
			additionalProperties: false,
		});
	});

	test("summaries read as sentences", () => {
		expect(summaryOf("projects.list")).toBe("List projects");
		expect(summaryOf("projects.all")).toBe("All projects");
		expect(summaryOf("projects.create")).toBe("Create project");
		expect(summaryOf("compose.crud.create")).toBe("Create compose");
		expect(summaryOf("applications.deploy.cancelDeployments")).toBe(
			"Cancel deployments",
		);
		expect(summaryOf("applications.deploy.start")).toBe("Start application");
		expect(summaryOf("applications.deploy.deploy")).toBe("Deploy application");
		expect(summaryOf("compose.deploy.stop")).toBe("Stop compose");
		expect(summaryOf("sshKeys.remove")).toBe("Remove SSH key");
		expect(summaryOf("platform.dns.get")).toBe("Get DNS");
		expect(summaryOf("sources.registries.get")).toBe("Get registry");
		expect(summaryOf("live.sandboxes.kill")).toBe("Kill sandbox");
		expect(summaryOf("applications.patches.get")).toBe("Get patch");
		expect(summaryOf("databases.databases.stop")).toBe("Stop database");
		expect(summaryOf("platform.settings.get")).toBe("Get settings");
		expect(summaryOf("infra.domains.validateHost")).toBe("Validate host");
		expect(summaryOf("platform.aiActions.listModels")).toBe("List models");
	});
});
