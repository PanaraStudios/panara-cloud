// Turns the OpenAPI document (`/api/v1/openapi.json`) into what the API
// reference page shows: groups, modules, operations, readable types and a
// curl example for each operation.

export type Schema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	anyOf?: Schema[];
	enum?: unknown[];
	const?: unknown;
	additionalProperties?: boolean | Schema;
};

type Content = { "application/json"?: { schema?: Schema } };

type OpenApiOperation = {
	operationId: string;
	tags?: string[];
	summary?: string;
	description?: string;
	"x-kind"?: "query" | "mutation" | "action";
	parameters?: {
		name: string;
		in: string;
		required?: boolean;
		schema?: Schema;
		content?: Content;
	}[];
	requestBody?: { content?: Content };
	responses?: Record<string, { content?: Content }>;
};

export type OpenApi = {
	info: { title: string; version: string };
	servers?: { url: string }[];
	paths: Record<string, Partial<Record<"get" | "post", OpenApiOperation>>>;
	"x-tagGroups"?: { name: string; tags: string[] }[];
};

export type ReferenceOperation = {
	id: string;
	path: string;
	methods: ("GET" | "POST")[];
	summary: string;
	description: string;
	kind: "query" | "mutation" | "action" | null;
	module: string;
	// The JSON object of arguments; null for plain REST routes.
	args: Schema | null;
	// Path and query parameters of plain REST routes.
	parameters: { name: string; in: string; required: boolean; schema: Schema }[];
	result: Schema | null;
};

export type ReferenceModule = {
	name: string;
	operations: ReferenceOperation[];
};

export type ReferenceGroup = {
	id: string;
	modules: ReferenceModule[];
	count: number;
};

const KIND_NOTES = new Set([
	"Reads data and changes nothing.",
	"Changes data in one transaction.",
	"May call other services and take longer.",
]);

const toOperation = (
	path: string,
	item: Partial<Record<"get" | "post", OpenApiOperation>>,
): ReferenceOperation | null => {
	const primary = item.post ?? item.get;
	if (!primary) return null;
	const isCall = path.startsWith("/call/");
	const data =
		primary.responses?.["200"]?.content?.["application/json"]?.schema
			?.properties?.data;
	return {
		id: isCall ? path.slice("/call/".length) : primary.operationId,
		path,
		methods: [
			...(item.get ? (["GET"] as const) : []),
			...(item.post ? (["POST"] as const) : []),
		],
		summary: primary.summary ?? "",
		description: (primary.description ?? "")
			.split("\n\n")
			.filter((paragraph) => !KIND_NOTES.has(paragraph))
			.join("\n\n"),
		kind: primary["x-kind"] ?? null,
		module: primary.tags?.[0] ?? "",
		args: isCall
			? (primary.requestBody?.content?.["application/json"]?.schema ?? null)
			: null,
		parameters: isCall
			? []
			: (primary.parameters ?? []).map((parameter) => ({
					name: parameter.name,
					in: parameter.in,
					required: parameter.required === true,
					schema: parameter.schema ?? {},
				})),
		result: data && Object.keys(data).length > 0 ? data : null,
	};
};

export const buildReference = (document: OpenApi): ReferenceGroup[] => {
	const byModule = new Map<string, ReferenceOperation[]>();
	for (const [path, item] of Object.entries(document.paths)) {
		const operation = toOperation(path, item);
		if (!operation) continue;
		const list = byModule.get(operation.module) ?? [];
		list.push(operation);
		byModule.set(operation.module, list);
	}
	return (document["x-tagGroups"] ?? [])
		.map((group) => {
			const modules = group.tags
				.map((name) => ({ name, operations: byModule.get(name) ?? [] }))
				.filter((module) => module.operations.length > 0);
			return {
				id: group.name,
				modules,
				count: modules.reduce((sum, m) => sum + m.operations.length, 0),
			};
		})
		.filter((group) => group.count > 0);
};

const matches = (operation: ReferenceOperation, terms: string[]) => {
	const text =
		`${operation.id} ${operation.path} ${operation.summary} ${operation.description}`.toLowerCase();
	return terms.every((term) => text.includes(term));
};

export const searchReference = (
	groups: ReferenceGroup[],
	query: string,
): ReferenceGroup[] => {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return groups;
	return groups
		.map((group) => {
			const modules = group.modules
				.map((module) => ({
					name: module.name,
					operations: module.operations.filter((operation) =>
						matches(operation, terms),
					),
				}))
				.filter((module) => module.operations.length > 0);
			return {
				id: group.id,
				modules,
				count: modules.reduce((sum, m) => sum + m.operations.length, 0),
			};
		})
		.filter((group) => group.count > 0);
};

// "applications" -> "Applications", "serviceEvents" -> "Service events",
// "sshKeys" -> "SSH keys", "rest" -> "REST".
const ACRONYMS: Record<string, string> = {
	ssh: "SSH",
	rest: "REST",
	dns: "DNS",
	ai: "AI",
	api: "API",
};

export const titleOf = (identifier: string): string => {
	const words = identifier
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s.]+/)
		.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
	const text = words.join(" ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};

const DOCUMENT_ID = /^Id of a document in "([^"]+)"$/;
const MAX_ENUM_VALUES = 6;
const MAX_INLINE_FIELDS = 4;

const wrap = (label: string) => (label.includes(" | ") ? `(${label})` : label);

// A JSON Schema as the short type a developer would write.
export const typeLabel = (
	schema: Schema | undefined,
	nested = false,
): string => {
	if (!schema) return "any";
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) {
		const values = schema.enum.map((value) => JSON.stringify(value));
		return values.length > MAX_ENUM_VALUES
			? `${values.slice(0, MAX_ENUM_VALUES).join(" | ")} | … ${values.length - MAX_ENUM_VALUES} more`
			: values.join(" | ");
	}
	if (schema.anyOf) {
		return [
			...new Set(schema.anyOf.map((member) => typeLabel(member, true))),
		].join(" | ");
	}
	const type = Array.isArray(schema.type)
		? schema.type.join(" | ")
		: schema.type;
	if (type === "array") return `${wrap(typeLabel(schema.items, true))}[]`;
	if (type === "string") {
		const table = DOCUMENT_ID.exec(schema.description ?? "")?.[1];
		return table ? `Id<"${table}">` : "string";
	}
	if (type === "object") {
		const properties = schema.properties ?? {};
		const names = Object.keys(properties);
		if (names.includes("$integer")) return "int64";
		if (names.includes("$bytes")) return "bytes";
		if (
			names.length === 0 &&
			schema.additionalProperties &&
			typeof schema.additionalProperties === "object"
		) {
			return `Record<string, ${typeLabel(schema.additionalProperties, true)}>`;
		}
		if (nested && names.length > 0 && names.length <= MAX_INLINE_FIELDS) {
			const required = new Set(schema.required ?? []);
			return `{ ${names
				.map(
					(name) =>
						`${name}${required.has(name) ? "" : "?"}: ${typeLabel(properties[name], true)}`,
				)
				.join("; ")} }`;
		}
		return "object";
	}
	return type ?? "any";
};

export type Field = {
	path: string;
	type: string;
	required: boolean;
	description: string;
};

const MAX_DEPTH = 3;

const childObject = (
	schema: Schema,
): { schema: Schema; suffix: string } | null => {
	if (schema.type === "object" && schema.properties) {
		const names = Object.keys(schema.properties);
		if (names.includes("$integer") || names.includes("$bytes")) return null;
		return { schema, suffix: "" };
	}
	if (schema.type === "array" && schema.items) {
		const inner = childObject(schema.items);
		return inner ? { schema: inner.schema, suffix: `[]${inner.suffix}` } : null;
	}
	return null;
};

// The fields of an object schema, nested ones as dotted paths.
export const fieldsOf = (
	schema: Schema | null,
	prefix = "",
	depth = 0,
): Field[] => {
	if (!schema?.properties) return [];
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties).flatMap(([name, property]) => {
		const path = `${prefix}${name}`;
		const description = DOCUMENT_ID.test(property.description ?? "")
			? ""
			: (property.description ?? "");
		const field: Field = {
			path,
			type: typeLabel(property),
			required: required.has(name),
			description,
		};
		const child = depth + 1 < MAX_DEPTH ? childObject(property) : null;
		return child
			? [field, ...fieldsOf(child.schema, `${path}${child.suffix}.`, depth + 1)]
			: [field];
	});
};

const exampleValue = (schema: Schema, name: string): unknown => {
	if (schema.const !== undefined) return schema.const;
	if (schema.enum) return schema.enum[0];
	if (schema.anyOf) {
		const member =
			schema.anyOf.find((candidate) => candidate.type !== "null") ??
			schema.anyOf[0];
		return member ? exampleValue(member, name) : null;
	}
	switch (schema.type) {
		case "string":
			return `<${name}>`;
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "array":
			return [];
		case "object":
			return exampleArgs(schema);
		default:
			return null;
	}
};

// Arguments that satisfy the schema's required fields, with placeholders.
export const exampleArgs = (schema: Schema | null): Record<string, unknown> => {
	const result: Record<string, unknown> = {};
	for (const name of schema?.required ?? []) {
		const property = schema?.properties?.[name];
		if (property) result[name] = exampleValue(property, name);
	}
	return result;
};

export const API_KEY_VARIABLE = "PANARA_CLOUD_KEY";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const curlExample = (
	origin: string,
	operation: ReferenceOperation,
): string => {
	const auth = `  -H "x-api-key: $${API_KEY_VARIABLE}"`;
	if (!operation.methods.includes("POST")) {
		const path = operation.path.replace(/\{(\w+)\}/g, "<$1>");
		return [`curl ${origin}/api/v1${path} \\`, auth].join("\n");
	}
	const url = `curl -X POST ${origin}/api/v1${operation.path} \\`;
	const args = exampleArgs(operation.args);
	if (Object.keys(args).length === 0) return [url, auth].join("\n");
	return [
		url,
		`${auth} \\`,
		'  -H "Content-Type: application/json" \\',
		`  -d ${shellQuote(JSON.stringify(args))}`,
	].join("\n");
};

export const mcpUrl = (origin: string, groups: string[] = []): string =>
	`${origin}/api/mcp${groups.length > 0 ? `?groups=${groups.join(",")}` : ""}`;

export const claudeCodeCommand = (origin: string): string =>
	[
		"claude mcp add --transport http panara-cloud \\",
		`  ${mcpUrl(origin)} \\`,
		`  --header "Authorization: Bearer $${API_KEY_VARIABLE}"`,
	].join("\n");

export const mcpServersJson = (origin: string): string =>
	JSON.stringify(
		{
			mcpServers: {
				"panara-cloud": {
					type: "http",
					url: mcpUrl(origin),
					headers: { Authorization: "Bearer <your API key>" },
				},
			},
		},
		null,
		2,
	);
