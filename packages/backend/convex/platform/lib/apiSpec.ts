import { type FunctionKind, groupOf, moduleOf } from "./apiPolicy";

// Builds the OpenAPI document and the MCP tool list from the function
// catalog (api/catalog.json). No Convex imports: the web app uses it too.

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonSchema = { [key: string]: JsonValue };

// The JSON form of a Convex validator, as `exportArgs()` returns it.
export type ValidatorJson =
	| { type: "null" | "number" | "bigint" | "boolean" | "string" | "bytes" }
	| { type: "any" }
	| { type: "literal"; value: JsonValue }
	| { type: "id"; tableName: string }
	| { type: "array"; value: ValidatorJson }
	| {
			type: "record";
			keys: ValidatorJson;
			values: { fieldType: ValidatorJson; optional: boolean };
	  }
	| {
			type: "object";
			value: Record<string, { fieldType: ValidatorJson; optional: boolean }>;
	  }
	| { type: "union"; value: ValidatorJson[] };

export type CatalogFunction = {
	name: string;
	kind: FunctionKind;
	description?: string;
	args: ValidatorJson;
	returns: ValidatorJson | null;
};

export type Catalog = { functions: CatalogFunction[] };

export const API_BASE_PATH = "/api/v1";
// The API's own version, in the OpenAPI document and the MCP server's info.
// Never the panel's release: both are served before a key is checked, and the
// release tells a scanner which fixes an install is missing.
export const API_VERSION = "1";
export const callPath = (name: string): string => `/call/${name}`;

type SchemaOptions = {
	// Some MCP clients only accept property names made of letters, digits,
	// `_`, `.` and `-`, which rules out spelling out `$integer` and `$bytes`.
	plainKeys?: boolean;
};

const encoded = (
	key: "$integer" | "$bytes",
	description: string,
	options: SchemaOptions,
): JsonSchema =>
	options.plainKeys
		? { type: "object", description }
		: {
				type: "object",
				description,
				properties: { [key]: { type: "string" } },
				required: [key],
				additionalProperties: false,
			};

export const toJsonSchema = (
	validator: ValidatorJson,
	options: SchemaOptions = {},
): JsonSchema => {
	switch (validator.type) {
		case "null":
			return { type: "null" };
		case "number":
			return { type: "number" };
		case "boolean":
			return { type: "boolean" };
		case "string":
			return { type: "string" };
		case "bigint":
			return encoded(
				"$integer",
				'A 64-bit integer as {"$integer": "<base64 of 8 little-endian bytes>"}',
				options,
			);
		case "bytes":
			return encoded(
				"$bytes",
				'Binary data as {"$bytes": "<base64>"}',
				options,
			);
		case "any":
			return {};
		case "literal":
			return { const: validator.value };
		case "id":
			return {
				type: "string",
				description: `Id of a document in "${validator.tableName}"`,
			};
		case "array":
			return { type: "array", items: toJsonSchema(validator.value, options) };
		case "record":
			return {
				type: "object",
				additionalProperties: toJsonSchema(validator.values.fieldType, options),
			};
		case "object": {
			const properties: Record<string, JsonSchema> = {};
			const required: string[] = [];
			for (const [name, field] of Object.entries(validator.value)) {
				properties[name] = toJsonSchema(field.fieldType, options);
				if (!field.optional) required.push(name);
			}
			return {
				type: "object",
				properties,
				...(required.length > 0 ? { required } : {}),
				additionalProperties: false,
			};
		}
		case "union": {
			const members = validator.value;
			if (members.length > 0 && members.every((m) => m.type === "literal")) {
				return {
					enum: members.map((m) => (m as { value: JsonValue }).value),
				};
			}
			return { anyOf: members.map((m) => toJsonSchema(m, options)) };
		}
	}
};

const ACRONYMS = new Set(["ai", "api", "dns", "gpu", "ip", "ssh", "url"]);

const words = (identifier: string): string[] =>
	identifier
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/\s+/)
		.map((word) => word.toLowerCase())
		.map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));

const sentence = (parts: string[]): string => {
	const text = parts.join(" ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};

const UNCOUNTABLE = new Set(["access", "settings", "status"]);

const singular = (word: string): string => {
	if (
		word.length <= 3 ||
		UNCOUNTABLE.has(word) ||
		word === word.toUpperCase()
	) {
		return word;
	}
	if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
	if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
	return word;
};

// Module files named after what they do rather than what they hold: their
// functions act on the parent ("applications.deploy.start" starts an
// application).
const GENERIC_MODULE_LEAVES = new Set(["crud", "deploy", "lib"]);
// Verbs that act on the whole collection, so the subject stays plural.
const COLLECTION_VERBS = new Set(["list", "all"]);

const subjectOf = (name: string, plural: boolean): string[] => {
	const segments = moduleOf(name).split(".");
	const leaf = segments.at(-1) ?? "";
	const subject = words(
		GENERIC_MODULE_LEAVES.has(leaf) ? (segments.at(-2) ?? leaf) : leaf,
	);
	const last = subject.at(-1) ?? "";
	return plural ? subject : [...subject.slice(0, -1), singular(last)];
};

// "projects.list" -> "List projects", "projects.create" -> "Create project",
// "applications.deploy.cancelDeployments" -> "Cancel deployments". A one-word
// function name borrows its module's.
export const summaryOf = (name: string): string => {
	const verb = words(name.slice(name.lastIndexOf(".") + 1));
	if (verb.length > 1) return sentence(verb);
	return sentence([...verb, ...subjectOf(name, COLLECTION_VERBS.has(verb[0]))]);
};

// "applications_deploy_start": MCP tool names allow no dots.
export const toolName = (name: string): string => name.replaceAll(".", "_");

const DESTRUCTIVE =
	/^(remove|delete|clear|clean|kill|revoke|reset|disconnect|prune|drop|wipe|rebuild|restore)/;

export const isDestructive = (fn: Pick<CatalogFunction, "name" | "kind">) =>
	fn.kind !== "query" &&
	DESTRUCTIVE.test(fn.name.slice(fn.name.lastIndexOf(".") + 1));

export type McpTool = {
	name: string;
	title: string;
	description: string;
	inputSchema: JsonSchema;
	annotations: {
		title: string;
		readOnlyHint: boolean;
		destructiveHint: boolean;
	};
};

const describe = (fn: CatalogFunction): string => {
	const summary = summaryOf(fn.name);
	return fn.description ? `${summary}. ${fn.description}` : `${summary}.`;
};

export const toMcpTool = (fn: CatalogFunction): McpTool => {
	const title = summaryOf(fn.name);
	return {
		name: toolName(fn.name),
		title,
		description: `${describe(fn)} (${fn.kind} ${fn.name})`,
		inputSchema: toJsonSchema(fn.args, { plainKeys: true }),
		annotations: {
			title,
			readOnlyHint: fn.kind === "query",
			destructiveHint: isDestructive(fn),
		},
	};
};

// `groups` is a comma-separated list of groups ("applications") or modules
// ("applications.deploy"); empty or missing means every function.
export const parseGroups = (value: string | null | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((group) => group.trim())
		.filter(Boolean);

export const inGroups = (name: string, groups: string[]): boolean => {
	if (groups.length === 0) return true;
	const module = moduleOf(name);
	return groups.some(
		(group) => module === group || module.startsWith(`${group}.`),
	);
};

export const mcpTools = (catalog: Catalog, groups: string[] = []): McpTool[] =>
	catalog.functions
		.filter((fn) => inGroups(fn.name, groups))
		.map((fn) => toMcpTool(fn));

export const groupsOf = (catalog: Catalog): string[] => [
	...new Set(catalog.functions.map((fn) => groupOf(fn.name))),
];

const ERROR_STATUSES: Record<string, string> = {
	"400": "The arguments were rejected",
	"401": "Missing, invalid or expired API key",
	"403": "The API key's user may not do this",
	"404": "Unknown function or resource",
	"429": "Rate limit or usage limit of the API key exceeded",
	"500": "Internal error",
};

const errorResponses = () =>
	Object.fromEntries(
		Object.keys(ERROR_STATUSES).map((status) => [
			status,
			{ $ref: `#/components/responses/Error${status}` },
		]),
	);

const dataResponse = (schema: JsonSchema, description: string) => ({
	description,
	content: {
		"application/json": {
			schema: {
				type: "object",
				properties: { data: schema },
				required: ["data"],
			},
		},
	},
});

const KIND_NOTE: Record<FunctionKind, string> = {
	query: "Reads data and changes nothing.",
	mutation: "Changes data in one transaction.",
	action: "May call other services and take longer.",
};

const operation = (fn: CatalogFunction) => ({
	tags: [moduleOf(fn.name)],
	summary: summaryOf(fn.name),
	description: [fn.description, KIND_NOTE[fn.kind]]
		.filter(Boolean)
		.join("\n\n"),
	"x-kind": fn.kind,
	responses: {
		"200": dataResponse(
			fn.returns ? toJsonSchema(fn.returns) : {},
			"The function's result",
		),
		...errorResponses(),
	},
});

const hasRequiredArgs = (fn: CatalogFunction): boolean =>
	fn.args.type === "object" &&
	Object.values(fn.args.value).some((field) => !field.optional);

const callOperations = (fn: CatalogFunction) => {
	const base = operation(fn);
	const argsSchema = toJsonSchema(fn.args);
	const required = hasRequiredArgs(fn);
	return {
		...(fn.kind === "query"
			? {
					get: {
						...base,
						operationId: `${fn.name}.get`,
						parameters: [
							{
								name: "args",
								in: "query",
								required,
								description: "The arguments as a URL-encoded JSON object",
								content: { "application/json": { schema: argsSchema } },
							},
						],
					},
				}
			: {}),
		post: {
			...base,
			operationId: fn.name,
			requestBody: {
				required,
				content: { "application/json": { schema: argsSchema } },
			},
		},
	};
};

const REST_TAG = "rest";

const restPaths = () => {
	const project = {
		type: "object",
		properties: {
			id: { type: "string" },
			name: { type: "string" },
			description: { type: ["string", "null"] },
			createdAt: { type: "number" },
		},
	};
	const responses = (schema: JsonSchema, description: string) => ({
		"200": dataResponse(schema, description),
		...errorResponses(),
	});
	return {
		"/me": {
			get: {
				tags: [REST_TAG],
				operationId: "rest.me",
				summary: "Who the API key acts as",
				responses: {
					"200": {
						description: "The key's user, organization and role",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										userId: { type: "string" },
										organizationId: { type: "string" },
										role: { enum: ["owner", "admin", "member"] },
									},
									required: ["userId", "organizationId", "role"],
								},
							},
						},
					},
					...errorResponses(),
				},
			},
		},
		"/projects": {
			get: {
				tags: [REST_TAG],
				operationId: "rest.projects.list",
				summary: "List the organization's projects",
				parameters: [
					{
						name: "limit",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1 },
					},
				],
				responses: responses(
					{ type: "array", items: project },
					"The projects the key's user can see",
				),
			},
		},
		"/projects/{projectId}": {
			get: {
				tags: [REST_TAG],
				operationId: "rest.projects.get",
				summary: "Get one project",
				parameters: [
					{
						name: "projectId",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: responses(project, "The project"),
			},
		},
	};
};

export const openApiDocument = (catalog: Catalog) => {
	const modules = [
		...new Set(catalog.functions.map((fn) => moduleOf(fn.name))),
	];
	const groups = groupsOf(catalog);
	return {
		openapi: "3.1.0",
		info: {
			title: "Panara Cloud API",
			version: API_VERSION,
			description:
				"Every operation of the Panara Cloud panel. Each function is called with `POST /call/<name>` and a JSON object of arguments; queries also answer `GET /call/<name>?args=<json>`. A call runs as the API key's user inside the key's organization.",
			license: { name: "MIT", identifier: "MIT" },
		},
		servers: [{ url: API_BASE_PATH }],
		security: [{ apiKey: [] }, { bearer: [] }],
		tags: [
			{
				name: REST_TAG,
				description: "Plain REST routes that predate the function gateway",
			},
			...modules.map((module) => ({
				name: module,
				description: `Functions of the ${module} module`,
				"x-group": module.split(".")[0],
			})),
		],
		"x-tagGroups": [
			{ name: REST_TAG, tags: [REST_TAG] },
			...groups.map((group) => ({
				name: group,
				tags: modules.filter(
					(module) => module === group || module.startsWith(`${group}.`),
				),
			})),
		],
		paths: {
			...restPaths(),
			...Object.fromEntries(
				catalog.functions.map((fn) => [callPath(fn.name), callOperations(fn)]),
			),
		},
		components: {
			securitySchemes: {
				apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
				bearer: { type: "http", scheme: "bearer" },
			},
			schemas: {
				Error: {
					type: "object",
					properties: { error: { type: "string" } },
					required: ["error"],
				},
			},
			responses: Object.fromEntries(
				Object.entries(ERROR_STATUSES).map(([status, description]) => [
					`Error${status}`,
					{
						description,
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Error" },
							},
						},
					},
				]),
			),
		},
	};
};

export type OpenApiDocument = ReturnType<typeof openApiDocument>;
