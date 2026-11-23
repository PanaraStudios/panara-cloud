import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { API_VERSION, parseGroups } from "@panara-cloud/backend/apiSpec";
import {
	type ApiCaller,
	type ApiResult,
	callFunction,
	functionForTool,
	readApiKey,
	toolsFor,
	WHOAMI_TOOL,
	whoAmI,
} from "@/lib/public-api";
import { readCappedBody } from "@/lib/request-body";

// The panel's MCP server (Streamable HTTP, stateless): one tool per function
// the API serves, authenticated with an API key. `?groups=a,b` narrows the
// tool list for clients that cope badly with several hundred tools. A tool
// call is a call to the API gateway, so scope, the deny list and rate limits
// are the gateway's.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const jsonRpcError = (
	status: number,
	message: string,
	headers: Record<string, string> = {},
) =>
	Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message }, id: null },
		{ status, headers: { ...NO_STORE, ...headers } },
	);

const toToolResult = (result: ApiResult): CallToolResult => {
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
		isError: true,
		content: [
			{
				type: "text",
				text: `${result.status}: ${result.body?.error ?? "Request failed"}${wait}`,
			},
		],
	};
};

const createServer = (caller: ApiCaller, groups: string[]) => {
	const server = new Server(
		{
			name: "panara-cloud",
			title: "Panara Cloud",
			version: API_VERSION,
		},
		{
			capabilities: { tools: {} },
			instructions:
				"Tools run Panara Cloud operations as the API key's user, inside the key's organization. Call whoami first for the organizationId most tools need. Tool names follow the API: projects_list is the function projects.list.",
		},
	);
	const tools = toolsFor(groups);
	const offered = new Set(tools.map((tool) => tool.name));
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		if (!offered.has(name)) {
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool ${name}` }],
			};
		}
		if (name === WHOAMI_TOOL.name) return toToolResult(await whoAmI(caller));
		const fn = functionForTool(name);
		if (!fn) {
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool ${name}` }],
			};
		}
		return toToolResult(await callFunction(caller, fn, args ?? {}));
	});
	return server;
};

type JsonRpcMessage = { method?: unknown; id?: unknown };

// A tool call is authenticated (and counted) by the gateway when it runs, and
// a notification does nothing here; checking the key for those as well would
// spend the key's rate limit twice per call.
const needsKeyCheck = (body: unknown): boolean => {
	const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
	return messages.some(
		(message) =>
			message !== null &&
			typeof message === "object" &&
			message.id !== undefined &&
			message.method !== "tools/call",
	);
};

export const POST = async (request: Request) => {
	// Browsers always send Origin; MCP clients don't. With none of the panel's
	// pages calling this endpoint, refusing every browser shuts out
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
	const raw = await readCappedBody(request);
	if (raw === null) return jsonRpcError(413, "Request larger than 4 MB");
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return Response.json(
			{
				jsonrpc: "2.0",
				error: { code: -32700, message: "Parse error" },
				id: null,
			},
			{ status: 400, headers: NO_STORE },
		);
	}
	if (needsKeyCheck(body)) {
		const identity = await whoAmI({ apiKey, request });
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
	const groups = parseGroups(new URL(request.url).searchParams.get("groups"));
	const server = createServer({ apiKey, request }, groups);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		const response = await transport.handleRequest(request, {
			parsedBody: body,
		});
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "no-store");
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	} finally {
		await server.close();
	}
};

// Stateless: there is no session to stream from or to end.
const notAllowed = () =>
	jsonRpcError(405, "Method not allowed", { Allow: "POST" });

export const GET = notAllowed;
export const DELETE = notAllowed;
