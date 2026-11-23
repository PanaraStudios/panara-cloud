import { API_VERSION, type McpTool, parseGroups } from "./apiSpec";

// The panel's MCP server (Streamable HTTP, stateless, JSON responses): one
// tool per function the API serves, authenticated with an API key.
// `?groups=a,b` narrows the tool list for clients that cope badly with
// several hundred tools. A tool call is a call to the API gateway, so scope,
// the deny list and rate limits are the gateway's.
//
// Until 0.1.7 this ran in the web app's Node server on the MCP TypeScript
// SDK (1.32); the answers here are the ones that SDK gave, which
// mcp.test.ts pins.

export type ApiResult = {
	status: number;
	body: { data?: unknown; error?: string } | null;
	retryAfter: string | null;
};

export type McpBackend = {
	/** The gateway's `/api/v1/me` for this key. */
	whoAmI: (apiKey: string) => Promise<ApiResult>;
	/** The gateway's `/api/v1/call/<name>` for this key. */
	call: (
		apiKey: string,
		name: string,
		args: Record<string, unknown>,
	) => Promise<ApiResult>;
	tools: (groups: string[]) => McpTool[];
	functionForTool: (tool: string) => string | undefined;
};

export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
	LATEST_PROTOCOL_VERSION,
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
];

const INSTRUCTIONS =
	"Tools run Panara Cloud operations as the API key's user, inside the key's organization. Call whoami first for the organizationId most tools need. Tool names follow the API: projects_list is the function projects.list.";

export const WHOAMI_TOOL: McpTool = {
	name: "whoami",
	title: "Who the API key acts as",
	description:
		"The user, organization and role this API key acts as. Most tools take an organizationId: use the one returned here.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	annotations: {
		title: "Who the API key acts as",
		readOnlyHint: true,
		destructiveHint: false,
	},
};

const NO_STORE = { "Cache-Control": "no-store" };

const jsonRpcError = (
	status: number,
	message: string,
	headers: Record<string, string> = {},
	code = -32000,
) =>
	Response.json(
		{ jsonrpc: "2.0", error: { code, message }, id: null },
		{ status, headers: { ...NO_STORE, ...headers } },
	);

export const readApiKey = (request: Request): string | null => {
	const header = request.headers.get("x-api-key")?.trim();
	if (header) return header;
	const match = /^Bearer\s+(.+)$/i.exec(
		request.headers.get("authorization") ?? "",
	);
	return match ? match[1].trim() : null;
};

type Id = string | number;
type Message = {
	jsonrpc: "2.0";
	id?: Id;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is Id =>
	typeof value === "string" ||
	(typeof value === "number" && Number.isInteger(value));

const isMessage = (value: unknown): value is Message => {
	if (!isObject(value) || value.jsonrpc !== "2.0") return false;
	if (typeof value.method === "string") {
		return (
			(value.id === undefined || isId(value.id)) &&
			(value.params === undefined || isObject(value.params))
		);
	}
	return isId(value.id) && ("result" in value || "error" in value);
};

const isRequest = (message: Message) =>
	typeof message.method === "string" && message.id !== undefined;

type Issue = { expected: string; path: string[]; received: unknown };

const typeName = (value: unknown) =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

// The SDK validated params with zod and answered a mismatch with zod's
// issue list as the message of an internal error.
const invalidParams = (issues: Issue[]) => ({
	code: -32603,
	message: JSON.stringify(
		issues.map(({ expected, path, received }) => ({
			expected,
			code: "invalid_type",
			path,
			message: `Invalid input: expected ${expected}, received ${typeName(received)}`,
		})),
		null,
		2,
	),
});

type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: true;
};

const toToolResult = (result: ApiResult): ToolResult => {
	if (result.status >= 200 && result.status < 300) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						result.body && "data" in result.body
							? result.body.data
							: result.body,
						null,
						2,
					),
				},
			],
		};
	}
	const wait = result.retryAfter ? ` Retry after ${result.retryAfter}s.` : "";
	return {
		content: [
			{
				type: "text",
				text: `${result.status}: ${result.body?.error ?? "Request failed"}${wait}`,
			},
		],
		isError: true,
	};
};

const toolError = (text: string): ToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

type Answer =
	| { result: unknown; jsonrpc: "2.0"; id: Id }
	| { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

async function answer(
	message: Message & { method: string; id: Id },
	apiKey: string,
	groups: string[],
	backend: McpBackend,
): Promise<Answer> {
	const ok = (result: unknown): Answer => ({
		result,
		jsonrpc: "2.0",
		id: message.id,
	});
	const fail = (error: { code: number; message: string }): Answer => ({
		jsonrpc: "2.0",
		id: message.id,
		error,
	});
	const params = message.params ?? {};
	switch (message.method) {
		case "initialize": {
			const issues: Issue[] = [];
			if (typeof params.protocolVersion !== "string") {
				issues.push({
					expected: "string",
					path: ["params", "protocolVersion"],
					received: params.protocolVersion,
				});
			}
			if (!isObject(params.capabilities)) {
				issues.push({
					expected: "object",
					path: ["params", "capabilities"],
					received: params.capabilities,
				});
			}
			if (!isObject(params.clientInfo)) {
				issues.push({
					expected: "object",
					path: ["params", "clientInfo"],
					received: params.clientInfo,
				});
			}
			if (issues.length) return fail(invalidParams(issues));
			const requested = params.protocolVersion as string;
			return ok({
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
					? requested
					: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: {
					name: "panara-cloud",
					title: "Panara Cloud",
					version: API_VERSION,
				},
				instructions: INSTRUCTIONS,
			});
		}
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: [WHOAMI_TOOL, ...backend.tools(groups)] });
		case "tools/call": {
			const issues: Issue[] = [];
			if (typeof params.name !== "string") {
				issues.push({
					expected: "string",
					path: ["params", "name"],
					received: params.name,
				});
			}
			if (params.arguments !== undefined && !isObject(params.arguments)) {
				issues.push({
					expected: "record",
					path: ["params", "arguments"],
					received: params.arguments,
				});
			}
			if (issues.length) return fail(invalidParams(issues));
			const name = params.name as string;
			const args = (params.arguments ?? {}) as Record<string, unknown>;
			const offered = new Set(
				[WHOAMI_TOOL, ...backend.tools(groups)].map((tool) => tool.name),
			);
			if (!offered.has(name)) return ok(toolError(`Unknown tool ${name}`));
			if (name === WHOAMI_TOOL.name) {
				return ok(toToolResult(await backend.whoAmI(apiKey)));
			}
			const fn = backend.functionForTool(name);
			if (!fn) return ok(toolError(`Unknown tool ${name}`));
			return ok(toToolResult(await backend.call(apiKey, fn, args)));
		}
		default:
			return fail({ code: -32601, message: "Method not found" });
	}
}

// A tool call is authenticated (and counted) by the gateway when it runs,
// and a notification does nothing here; checking the key for those as well
// would spend the key's rate limit twice per call.
const needsKeyCheck = (body: unknown): boolean => {
	const messages = (Array.isArray(body) ? body : [body]) as Message[];
	return messages.some(
		(message) =>
			message !== null &&
			typeof message === "object" &&
			message.id !== undefined &&
			message.method !== "tools/call",
	);
};

export async function handleMcp(
	request: Request,
	backend: McpBackend,
): Promise<Response> {
	if (request.method === "GET" || request.method === "DELETE") {
		// Stateless: there is no session to stream from or to end.
		return jsonRpcError(405, "Method not allowed", { Allow: "POST" });
	}
	// Browsers always send Origin; MCP clients don't. With none of the
	// panel's pages calling this endpoint, refusing every browser shuts out
	// cross-site and DNS-rebinding requests (the MCP transport rules ask
	// servers to check Origin).
	if (request.headers.get("origin") !== null) {
		return jsonRpcError(
			403,
			"The MCP endpoint is for MCP clients, not browsers",
		);
	}
	const apiKey = readApiKey(request);
	if (!apiKey) {
		return jsonRpcError(401, "Send an API key as a Bearer token or x-api-key", {
			"WWW-Authenticate": "Bearer",
		});
	}
	const declared = Number(request.headers.get("content-length") ?? 0);
	const raw =
		declared > MAX_MCP_BODY_BYTES ? null : await request.arrayBuffer();
	if (raw === null || raw.byteLength > MAX_MCP_BODY_BYTES) {
		return jsonRpcError(413, "Request larger than 4 MB");
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return jsonRpcError(400, "Parse error", {}, -32700);
	}
	if (needsKeyCheck(body)) {
		const identity = await backend.whoAmI(apiKey);
		if (identity.status !== 200) {
			return jsonRpcError(
				identity.status,
				identity.body?.error ?? "The API key was rejected",
				{
					...(identity.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
					...(identity.retryAfter
						? { "Retry-After": identity.retryAfter }
						: {}),
				},
			);
		}
	}
	const accept = request.headers.get("accept") ?? "";
	if (
		!accept.includes("application/json") ||
		!accept.includes("text/event-stream")
	) {
		return jsonRpcError(
			406,
			"Not Acceptable: Client must accept both application/json and text/event-stream",
		);
	}
	if (
		!(request.headers.get("content-type") ?? "").includes("application/json")
	) {
		return jsonRpcError(
			415,
			"Unsupported Media Type: Content-Type must be application/json",
		);
	}
	const messages = Array.isArray(body) ? body : [body];
	if (!messages.every(isMessage)) {
		return jsonRpcError(
			400,
			"Parse error: Invalid JSON-RPC message",
			{},
			-32700,
		);
	}
	const initializing = messages.some((m) => m.method === "initialize");
	if (initializing && messages.length > 1) {
		return jsonRpcError(
			400,
			"Invalid Request: Only one initialization request is allowed",
			{},
			-32600,
		);
	}
	if (!initializing) {
		const version = request.headers.get("mcp-protocol-version");
		if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
			return jsonRpcError(
				400,
				`Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
			);
		}
	}
	const requests = messages.filter(isRequest) as (Message & {
		method: string;
		id: Id;
	})[];
	if (requests.length === 0) {
		return new Response(null, { status: 202, headers: NO_STORE });
	}
	const groups = parseGroups(new URL(request.url).searchParams.get("groups"));
	const answers = await Promise.all(
		requests.map((message) => answer(message, apiKey, groups, backend)),
	);
	return Response.json(answers.length === 1 ? answers[0] : answers, {
		headers: NO_STORE,
	});
}
