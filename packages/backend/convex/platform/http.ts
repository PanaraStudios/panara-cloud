import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { type ActionCtx, httpAction } from "../_generated/server";
import { jsonError, requireApiKey } from "./lib/apiAuth";
import { CALL_PREFIX, handleApiCall } from "./lib/apiGateway";

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
		handler: apiRoute(async (ctx, req) => {
			try {
				const principal = await requireApiKey(ctx, req);
				return Response.json({
					userId: principal.userId,
					organizationId: principal.organizationId,
					role: principal.role,
				});
			} catch (error) {
				return jsonError(error);
			}
		}),
	});

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
