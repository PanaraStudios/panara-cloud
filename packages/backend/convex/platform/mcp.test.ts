import { describe, expect, test } from "vitest";
import catalogJson from "../../api/catalog.json";
import { type Catalog, mcpTools, toolName } from "./lib/apiSpec";
import { type ApiResult, handleMcp, type McpBackend } from "./lib/mcp";

// Requests and the answers the MCP server gave in 0.1.6, when it ran in the
// web app's Node server on the MCP TypeScript SDK 1.32.2 (recorded against
// a stand-in gateway: /me answers u1/o1/owner, every call a 429).
const GOLDEN: {
	name: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}[] = [
	{
		name: "no key",
		status: 401,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"www-authenticate": "Bearer",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Send an API key as a Bearer token or x-api-key"},"id":null}',
	},
	{
		name: "browser origin",
		status: 403,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"The MCP endpoint is for MCP clients, not browsers"},"id":null}',
	},
	{
		name: "GET",
		status: 405,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			allow: "POST",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed"},"id":null}',
	},
	{
		name: "DELETE",
		status: 405,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			allow: "POST",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed"},"id":null}',
	},
	{
		name: "parse error",
		status: 400,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}',
	},
	{
		name: "initialize",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"panara-cloud","title":"Panara Cloud","version":"1"},"instructions":"Tools run Panara Cloud operations as the API key\'s user, inside the key\'s organization. Call whoami first for the organizationId most tools need. Tool names follow the API: projects_list is the function projects.list."},"jsonrpc":"2.0","id":1}',
	},
	{
		name: "initialize old version",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"panara-cloud","title":"Panara Cloud","version":"1"},"instructions":"Tools run Panara Cloud operations as the API key\'s user, inside the key\'s organization. Call whoami first for the organizationId most tools need. Tool names follow the API: projects_list is the function projects.list."},"jsonrpc":"2.0","id":1}',
	},
	{
		name: "initialize unknown version",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"panara-cloud","title":"Panara Cloud","version":"1"},"instructions":"Tools run Panara Cloud operations as the API key\'s user, inside the key\'s organization. Call whoami first for the organizationId most tools need. Tool names follow the API: projects_list is the function projects.list."},"jsonrpc":"2.0","id":1}',
	},
	{
		name: "bad accept",
		status: 406,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}',
	},
	{
		name: "bad content-type",
		status: 415,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unsupported Media Type: Content-Type must be application/json"},"id":null}',
	},
	{
		name: "notification",
		status: 202,
		headers: {
			"cache-control": "no-store",
		},
		body: "",
	},
	{
		name: "ping",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{},"jsonrpc":"2.0","id":2}',
	},
	{
		name: "bad protocol header",
		status: 400,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 1999-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"},"id":null}',
	},
	{
		name: "unknown method",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}',
	},
	{
		name: "tools/list groups",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: "tools=10 first=whoami,projects_all,projects_create bytes=3921",
	},
	{
		name: "tools/call whoami",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"content":[{"type":"text","text":"{\\n  \\"userId\\": \\"u1\\",\\n  \\"organizationId\\": \\"o1\\",\\n  \\"role\\": \\"owner\\"\\n}"}]},"jsonrpc":"2.0","id":5}',
	},
	{
		name: "tools/call fn",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"content":[{"type":"text","text":"429: Rate limit exceeded Retry after 7s."}],"isError":true},"jsonrpc":"2.0","id":6}',
	},
	{
		name: "tools/call unknown",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"result":{"content":[{"type":"text","text":"Unknown tool nope_nope"}],"isError":true},"jsonrpc":"2.0","id":7}',
	},
	{
		name: "tools/call bad params",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","id":8,"error":{"code":-32603,"message":"[\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"params\\",\\n      \\"name\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  },\\n  {\\n    \\"expected\\": \\"record\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"params\\",\\n      \\"arguments\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected record, received number\\"\\n  }\\n]"}}',
	},
	{
		name: "batch",
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '[{"result":{},"jsonrpc":"2.0","id":9},{"result":{"content":[{"type":"text","text":"{\\n  \\"userId\\": \\"u1\\",\\n  \\"organizationId\\": \\"o1\\",\\n  \\"role\\": \\"owner\\"\\n}"}]},"jsonrpc":"2.0","id":10}]',
	},
	{
		name: "batch with initialize",
		status: 400,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: Only one initialization request is allowed"},"id":null}',
	},
	{
		name: "invalid jsonrpc",
		status: 400,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON-RPC message"},"id":null}',
	},
	{
		name: "too large",
		status: 413,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
		body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Request larger than 4 MB"},"id":null}',
	},
];

const A = "application/json, text/event-stream";
const J = { "content-type": "application/json" };
const init = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "t", version: "1" },
	},
};
const key = { ...J, accept: A, "x-api-key": "k" };
const versioned = { ...key, "mcp-protocol-version": "2025-06-18" };
const rpc = (body: unknown) => JSON.stringify(body);

const REQUESTS: Record<string, RequestInit & { query?: string }> = {
	"no key": { method: "POST", headers: { ...J, accept: A }, body: rpc(init) },
	"browser origin": {
		method: "POST",
		headers: { ...key, origin: "http://evil" },
		body: rpc(init),
	},
	GET: { method: "GET", headers: { "x-api-key": "k" } },
	DELETE: { method: "DELETE", headers: { "x-api-key": "k" } },
	"parse error": { method: "POST", headers: key, body: "{nope" },
	initialize: { method: "POST", headers: key, body: rpc(init) },
	"initialize old version": {
		method: "POST",
		headers: key,
		body: rpc({
			...init,
			params: { ...init.params, protocolVersion: "2024-11-05" },
		}),
	},
	"initialize unknown version": {
		method: "POST",
		headers: key,
		body: rpc({
			...init,
			params: { ...init.params, protocolVersion: "1999-01-01" },
		}),
	},
	"bad accept": {
		method: "POST",
		headers: { ...J, accept: "application/json", "x-api-key": "k" },
		body: rpc(init),
	},
	"bad content-type": {
		method: "POST",
		headers: { "content-type": "text/plain", accept: A, "x-api-key": "k" },
		body: rpc(init),
	},
	notification: {
		method: "POST",
		headers: versioned,
		body: rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
	},
	ping: {
		method: "POST",
		headers: versioned,
		body: rpc({ jsonrpc: "2.0", id: 2, method: "ping" }),
	},
	"bad protocol header": {
		method: "POST",
		headers: { ...key, "mcp-protocol-version": "1999-01-01" },
		body: rpc({ jsonrpc: "2.0", id: 2, method: "ping" }),
	},
	"unknown method": {
		method: "POST",
		headers: key,
		body: rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
	},
	"tools/list groups": {
		method: "POST",
		headers: key,
		body: rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
		query: "?groups=projects,nosuch",
	},
	"tools/call whoami": {
		method: "POST",
		headers: key,
		body: rpc({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "whoami", arguments: {} },
		}),
	},
	"tools/call fn": {
		method: "POST",
		headers: key,
		body: rpc({
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "projects_list", arguments: { organizationId: "x" } },
		}),
	},
	"tools/call unknown": {
		method: "POST",
		headers: key,
		body: rpc({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "nope_nope" },
		}),
	},
	"tools/call bad params": {
		method: "POST",
		headers: key,
		body: rpc({
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: { arguments: 3 },
		}),
	},
	batch: {
		method: "POST",
		headers: key,
		body: rpc([
			{ jsonrpc: "2.0", id: 9, method: "ping" },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { name: "whoami" },
			},
		]),
	},
	"batch with initialize": {
		method: "POST",
		headers: key,
		body: rpc([init, { jsonrpc: "2.0", id: 9, method: "ping" }]),
	},
	"invalid jsonrpc": { method: "POST", headers: key, body: rpc({ foo: 1 }) },
	"too large": {
		method: "POST",
		headers: key,
		body: "x".repeat(4 * 1024 * 1024 + 1),
	},
};

const catalog = catalogJson as Catalog;
const byTool = new Map(
	catalog.functions.map((fn) => [toolName(fn.name), fn.name]),
);
const calls: string[] = [];

const backend: McpBackend = {
	whoAmI: async (apiKey): Promise<ApiResult> => {
		calls.push(`me ${apiKey}`);
		return {
			status: 200,
			body: { userId: "u1", organizationId: "o1", role: "owner" } as never,
			retryAfter: null,
		};
	},
	call: async (apiKey, name, args) => {
		calls.push(`call ${apiKey} ${name} ${JSON.stringify(args)}`);
		return {
			status: 429,
			body: { error: "Rate limit exceeded" },
			retryAfter: "7",
		};
	},
	tools: (groups) => mcpTools(catalog, groups),
	functionForTool: (tool) => byTool.get(tool),
};

const HEADERS = [
	"content-type",
	"cache-control",
	"www-authenticate",
	"allow",
	"retry-after",
	"mcp-session-id",
];

describe("the MCP server answers as the SDK-based one did", () => {
	for (const golden of GOLDEN) {
		test(golden.name, async () => {
			const { query = "", ...init } = REQUESTS[golden.name];
			const response = await handleMcp(
				new Request(`http://panel.test/api/mcp${query}`, init),
				backend,
			);
			expect(response.status).toBe(golden.status);
			const headers = Object.fromEntries(
				HEADERS.map((name) => [name, response.headers.get(name)]).filter(
					([, value]) => value !== null,
				),
			);
			expect(headers).toEqual(golden.headers);
			let text = await response.text();
			if (golden.name === "tools/list groups") {
				const tools = JSON.parse(text).result.tools as { name: string }[];
				text = `tools=${tools.length} first=${tools
					.slice(0, 3)
					.map((t) => t.name)} bytes=${text.length}`;
			}
			expect(text).toBe(golden.body);
		});
	}
});

test("a tool call reaches the gateway once, with the tool's function", async () => {
	calls.length = 0;
	await handleMcp(
		new Request("http://panel.test/api/mcp", REQUESTS["tools/call fn"]),
		backend,
	);
	expect(calls).toEqual(['call k projects.list {"organizationId":"x"}']);
});
