import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { handleDeployWebhook } from "./webhooks";

const DEPLOY_PREFIX = "/api/deploy/";

export const registerApplicationsRoutes = (http: HttpRouter) => {
	// Deploy webhook: POST /api/deploy/<refreshToken>.
	// Longer prefixes (e.g. compose's /api/deploy/compose/) take precedence.
	http.route({
		pathPrefix: DEPLOY_PREFIX,
		method: "POST",
		handler: httpAction(async (ctx, req) => {
			const token = decodeURIComponent(
				new URL(req.url).pathname.slice(DEPLOY_PREFIX.length),
			).replace(/\/+$/, "");
			return await handleDeployWebhook(ctx, req, token);
		}),
	});
};
