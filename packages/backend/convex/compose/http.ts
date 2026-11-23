import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { handleComposeWebhook, WEBHOOK_PREFIX } from "./webhook";

export const registerComposeRoutes = (http: HttpRouter) => {
	http.route({
		pathPrefix: WEBHOOK_PREFIX,
		method: "POST",
		handler: httpAction(handleComposeWebhook),
	});
};
