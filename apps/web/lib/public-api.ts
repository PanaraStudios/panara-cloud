import "server-only";
import catalogJson from "@panara-cloud/backend/apiCatalog";
import {
	type Catalog,
	type McpTool,
	mcpTools,
	type OpenApiDocument,
	openApiDocument,
	toolName,
} from "@panara-cloud/backend/apiSpec";
import { clientIpProof } from "./client-ip";

// The panel's side of the public API: the OpenAPI document and the MCP tools
// come from the backend's function catalog, and every call goes to the
// gateway on Convex (`/api/v1/call/<name>`), which owns authentication,
// scope, the deny list and rate limits.

const catalog = catalogJson as Catalog;

let document: OpenApiDocument | undefined;

export const openApi = (): OpenApiDocument => {
	document ??= openApiDocument(catalog);
	return document;
};

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

export const toolsFor = (groups: string[]): McpTool[] => [
	WHOAMI_TOOL,
	...mcpTools(catalog, groups),
];

const functionByTool = new Map(
	catalog.functions.map((fn) => [toolName(fn.name), fn.name]),
);

export const functionForTool = (tool: string): string | undefined =>
	functionByTool.get(tool);

const siteUrl = (): string | null =>
	process.env.CONVEX_INTERNAL_SITE_URL?.replace(/\/+$/, "") ?? null;

export type ApiResult = {
	status: number;
	body: { data?: unknown; error?: string } | null;
	retryAfter: string | null;
};

// Who is calling: the API key and the request it came with, whose client
// address Convex uses for its limits on failed keys.
export type ApiCaller = { apiKey: string; request: Request };

const send = async (
	path: string,
	{ apiKey, request }: ApiCaller,
	init: RequestInit = {},
): Promise<ApiResult> => {
	const base = siteUrl();
	if (!base) {
		return {
			status: 503,
			body: { error: "The API is not available on this panel" },
			retryAfter: null,
		};
	}
	const response = await fetch(`${base}/api/v1${path}`, {
		...init,
		headers: {
			...init.headers,
			...clientIpProof(request.headers),
			"x-api-key": apiKey,
		},
		cache: "no-store",
	});
	return {
		status: response.status,
		body: await response.json().catch(() => null),
		retryAfter: response.headers.get("retry-after"),
	};
};

export const whoAmI = (caller: ApiCaller) => send("/me", caller);

export const callFunction = (
	caller: ApiCaller,
	name: string,
	args: Record<string, unknown>,
) =>
	send(`/call/${encodeURIComponent(name)}`, caller, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(args),
	});

export const readApiKey = (request: Request): string | null => {
	const header = request.headers.get("x-api-key")?.trim();
	if (header) return header;
	const match = /^Bearer\s+(.+)$/i.exec(
		request.headers.get("authorization") ?? "",
	);
	return match ? match[1].trim() : null;
};
