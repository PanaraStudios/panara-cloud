import type { HttpRouter } from "convex/server";
import catalogJson from "../../api/catalog.json";
import { internal } from "../_generated/api";
import { type ActionCtx, httpAction } from "../_generated/server";
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER } from "../authLimits";
import { jsonError, requireApiKey, whoAmI } from "./lib/apiAuth";
import { CALL_PREFIX, handleApiCall } from "./lib/apiGateway";
import { type Catalog, mcpTools, toolName } from "./lib/apiSpec";
import { type ApiResult, handleMcp, type McpBackend } from "./lib/mcp";

const API_PREFIX = "/api/v1";

// Answers carry data of one key's user. Behind a CDN that caches by URL (a
// "cache everything" rule on the panel's domain, which also serves
// /convex-site), a cacheable GET would hand them to the next caller.
const apiRoute = (
	handler: (ctx: ActionCtx, req: Request) => Promise<Response>,
) =>
	httpAction(async (ctx, req) => {
		const response = await handler(ctx, req);
		response.headers.set("Cache-Control", "no-store");
		return response;
	});
const DEFAULT_PAGE_SIZE = 100;

const catalog = catalogJson as Catalog;
const functionByTool = new Map(
	catalog.functions.map((fn) => [toolName(fn.name), fn.name]),
);

const toResult = async (response: Response): Promise<ApiResult> => ({
	status: response.status,
	body: await response.json().catch(() => null),
	retryAfter: response.headers.get("retry-after"),
});

// MCP tool calls go through the same handlers as the REST routes, with the
// MCP request's API key and the client address the web server vouched for.
const gatewayBackend = (ctx: ActionCtx, req: Request): McpBackend => {
	const origin = new URL(req.url).origin;
	const headers = (apiKey: string) => {
		const out: Record<string, string> = { "x-api-key": apiKey };
		for (const name of [PROXY_SECRET_HEADER, CLIENT_IP_HEADER]) {
			const value = req.headers.get(name);
			if (value) out[name] = value;
		}
		return out;
	};
	return {
		whoAmI: async (apiKey) =>
			toResult(
				await whoAmI(
					ctx,
					new Request(`${origin}${API_PREFIX}/me`, {
						headers: headers(apiKey),
					}),
				),
			),
		call: async (apiKey, name, args) =>
			toResult(
				await handleApiCall(
					ctx,
					new Request(`${origin}${CALL_PREFIX}${encodeURIComponent(name)}`, {
						method: "POST",
						headers: {
							...headers(apiKey),
							"content-type": "application/json",
						},
						body: JSON.stringify(args),
					}),
				),
			),
		tools: (groups) => mcpTools(catalog, groups),
		functionForTool: (tool) => functionByTool.get(tool),
	};
};

export const registerPlatformRoutes = (http: HttpRouter) => {
	for (const method of ["GET", "POST"] as const) {
		http.route({
			pathPrefix: CALL_PREFIX,
			method,
			handler: apiRoute((ctx, req) => handleApiCall(ctx, req)),
		});
	}

	http.route({
		path: `${API_PREFIX}/me`,
		method: "GET",
		handler: apiRoute((ctx, req) => whoAmI(ctx, req)),
	});

	// The web server proxies the panel's /api/mcp here, as it does
	// /api/v1/*; the MCP server used to run in the web app's Node server.
	for (const method of ["POST", "GET", "DELETE"] as const) {
		http.route({
			path: "/api/mcp",
			method,
			handler: httpAction((ctx, req) =>
				handleMcp(req, gatewayBackend(ctx, req)),
			),
		});
	}

	http.route({
		path: `${API_PREFIX}/projects`,
		method: "GET",
		handler: apiRoute(async (ctx, req) => {
			try {
				const { organizationId, userId } = await requireApiKey(ctx, req);
				const limit = Number(
					new URL(req.url).searchParams.get("limit") ?? DEFAULT_PAGE_SIZE,
				);
				const projects = await ctx.runQuery(
					internal.platform.publicApi.listProjects,
					{
						organizationId,
						userId,
						limit: Number.isFinite(limit) ? limit : DEFAULT_PAGE_SIZE,
					},
				);
				return Response.json({ data: projects });
			} catch (error) {
				return jsonError(error);
			}
		}),
	});

	http.route({
		pathPrefix: `${API_PREFIX}/projects/`,
		method: "GET",
		handler: apiRoute(async (ctx, req) => {
			try {
				const { organizationId, userId } = await requireApiKey(ctx, req);
				const projectId = decodeURIComponent(
					new URL(req.url).pathname.slice(`${API_PREFIX}/projects/`.length),
				);
				const project = projectId.includes("/")
					? null
					: await ctx.runQuery(internal.platform.publicApi.getProject, {
							organizationId,
							userId,
							projectId,
						});
				if (!project) {
					return Response.json({ error: "Not found" }, { status: 404 });
				}
				return Response.json({ data: project });
			} catch (error) {
				return jsonError(error);
			}
		}),
	});
};
