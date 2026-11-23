import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildReference,
	claudeCodeCommand,
	curlExample,
	exampleArgs,
	fieldsOf,
	mcpServersJson,
	mcpUrl,
	type OpenApi,
	searchReference,
	titleOf,
	typeLabel,
} from "./api-reference.ts";

const data = (schema: object) => ({
	"200": {
		content: {
			"application/json": {
				schema: { type: "object", properties: { data: schema } },
			},
		},
	},
});

const document: OpenApi = {
	info: { title: "Panara Cloud API", version: "1" },
	paths: {
		"/me": {
			get: { operationId: "rest.me", tags: ["rest"], summary: "Who am I" },
		},
		"/projects/{projectId}": {
			get: {
				operationId: "rest.projects.get",
				tags: ["rest"],
				summary: "Get one project",
				parameters: [
					{
						name: "projectId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
			},
		},
		"/call/projects.list": {
			get: { operationId: "projects.list.get", tags: ["projects"] },
			post: {
				operationId: "projects.list",
				tags: ["projects"],
				summary: "List projects",
				description: "Projects you can see.\n\nReads data and changes nothing.",
				"x-kind": "query",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { organizationId: { type: "string" } },
								required: ["organizationId"],
							},
						},
					},
				},
				responses: data({}),
			},
		},
		"/call/applications.deploy.start": {
			post: {
				operationId: "applications.deploy.start",
				tags: ["applications.deploy"],
				summary: "Start deploy",
				"x-kind": "mutation",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									applicationId: {
										type: "string",
										description: 'Id of a document in "applications"',
									},
									note: { type: "string" },
								},
								required: ["applicationId"],
							},
						},
					},
				},
				responses: data({ type: "null" }),
			},
		},
	},
	"x-tagGroups": [
		{ name: "rest", tags: ["rest"] },
		{ name: "applications", tags: ["applications.deploy", "applications.x"] },
		{ name: "projects", tags: ["projects"] },
		{ name: "empty", tags: ["nothing"] },
	],
};

const groups = buildReference(document);
const find = (id: string) => {
	const operation = groups
		.flatMap((group) => group.modules)
		.flatMap((module) => module.operations)
		.find((candidate) => candidate.id === id);
	assert.ok(operation, id);
	return operation;
};

test("operations are grouped by tag group and module, empty ones dropped", () => {
	assert.deepEqual(
		groups.map((group) => [group.id, group.count]),
		[
			["rest", 2],
			["applications", 1],
			["projects", 1],
		],
	);
	assert.deepEqual(
		groups[1].modules.map((module) => module.name),
		["applications.deploy"],
	);
});

test("a query answers GET and POST; its kind note is not repeated", () => {
	const list = find("projects.list");
	assert.deepEqual(list.methods, ["GET", "POST"]);
	assert.equal(list.kind, "query");
	assert.equal(list.description, "Projects you can see.");
	assert.equal(list.result, null);
	assert.deepEqual(find("applications.deploy.start").methods, ["POST"]);
	assert.deepEqual(find("applications.deploy.start").result, { type: "null" });
});

test("search matches every term against name, path and text", () => {
	assert.deepEqual(
		searchReference(groups, "deploy start").map((group) => group.id),
		["applications"],
	);
	assert.equal(searchReference(groups, "  ").length, groups.length);
	assert.deepEqual(searchReference(groups, "nothing-like-this"), []);
	assert.deepEqual(
		searchReference(groups, "SEE").map((group) => group.id),
		["projects"],
	);
});

test("types read like the ones a developer writes", () => {
	assert.equal(typeLabel({ type: "string" }), "string");
	assert.equal(
		typeLabel({
			type: "string",
			description: 'Id of a document in "projects"',
		}),
		'Id<"projects">',
	);
	assert.equal(typeLabel({ enum: ["a", "b"] }), '"a" | "b"');
	assert.equal(
		typeLabel({ anyOf: [{ type: "string" }, { type: "null" }] }),
		"string | null",
	);
	assert.equal(
		typeLabel({
			type: "array",
			items: { anyOf: [{ type: "string" }, { type: "number" }] },
		}),
		"(string | number)[]",
	);
	assert.equal(
		typeLabel({ type: "object", additionalProperties: { type: "number" } }),
		"Record<string, number>",
	);
	assert.equal(
		typeLabel({
			type: "object",
			properties: { $integer: { type: "string" } },
		}),
		"int64",
	);
	assert.equal(
		typeLabel({
			anyOf: [
				{
					type: "object",
					properties: {
						kind: { const: "application" },
						id: { type: "string" },
					},
					required: ["kind", "id"],
				},
				{ type: "null" },
			],
		}),
		'{ kind: "application"; id: string } | null',
	);
	assert.equal(typeLabel({}), "any");
	assert.equal(typeLabel(undefined), "any");
});

test("fields list nested objects as dotted paths", () => {
	assert.deepEqual(
		fieldsOf({
			type: "object",
			properties: {
				name: { type: "string" },
				source: {
					type: "object",
					properties: { branch: { type: "string", description: "Git branch" } },
					required: ["branch"],
				},
				mounts: {
					type: "array",
					items: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			},
			required: ["name"],
		}),
		[
			{ path: "name", type: "string", required: true, description: "" },
			{ path: "source", type: "object", required: false, description: "" },
			{
				path: "source.branch",
				type: "string",
				required: true,
				description: "Git branch",
			},
			{
				path: "mounts",
				type: "{ path?: string }[]",
				required: false,
				description: "",
			},
			{
				path: "mounts[].path",
				type: "string",
				required: false,
				description: "",
			},
		],
	);
	assert.deepEqual(fieldsOf(null), []);
});

test("the example carries the required arguments only", () => {
	const start = find("applications.deploy.start");
	assert.deepEqual(exampleArgs(start.args), {
		applicationId: "<applicationId>",
	});
	assert.equal(
		curlExample("https://panel.example.test", start),
		[
			"curl -X POST https://panel.example.test/api/v1/call/applications.deploy.start \\",
			'  -H "x-api-key: $PANARA_CLOUD_KEY" \\',
			'  -H "Content-Type: application/json" \\',
			`  -d '{"applicationId":"<applicationId>"}'`,
		].join("\n"),
	);
	assert.equal(
		curlExample("https://panel.example.test", find("rest.projects.get")),
		[
			"curl https://panel.example.test/api/v1/projects/<projectId> \\",
			'  -H "x-api-key: $PANARA_CLOUD_KEY"',
		].join("\n"),
	);
});

test("a value with a quote stays one shell argument", () => {
	const operation = {
		...find("applications.deploy.start"),
		args: {
			type: "object",
			properties: { note: { const: "it's" } },
			required: ["note"],
		},
	};
	assert.ok(
		curlExample("http://x", operation).endsWith(`-d '{"note":"it'\\''s"}'`),
	);
});

test("MCP setup snippets point at the panel's own endpoint", () => {
	assert.equal(mcpUrl("https://p.test"), "https://p.test/api/mcp");
	assert.equal(
		mcpUrl("https://p.test", ["projects", "applications"]),
		"https://p.test/api/mcp?groups=projects,applications",
	);
	assert.match(
		claudeCodeCommand("https://p.test"),
		/^claude mcp add --transport http panara-cloud \\\n {2}https:\/\/p\.test\/api\/mcp \\\n {2}--header "Authorization: Bearer \$PANARA_CLOUD_KEY"$/,
	);
	assert.deepEqual(JSON.parse(mcpServersJson("https://p.test")), {
		mcpServers: {
			"panara-cloud": {
				type: "http",
				url: "https://p.test/api/mcp",
				headers: { Authorization: "Bearer <your API key>" },
			},
		},
	});
});

test("group titles are sentence case with known acronyms", () => {
	assert.equal(titleOf("applications"), "Applications");
	assert.equal(titleOf("serviceEvents"), "Service events");
	assert.equal(titleOf("sshKeys"), "SSH keys");
	assert.equal(titleOf("rest"), "REST");
});
