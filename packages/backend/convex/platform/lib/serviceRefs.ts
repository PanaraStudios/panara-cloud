import type { QueryCtx } from "../../_generated/server";

export type ServiceRef = {
	organizationId: string;
	name: string;
	appName: string;
	serverId?: string;
	composeType?: "docker-compose" | "stack";
};

export const resolveServiceRef = async (
	ctx: QueryCtx,
	kind: "application" | "compose",
	id: string,
): Promise<ServiceRef | null> => {
	if (kind === "application") {
		const appId = ctx.db.normalizeId("applications", id);
		const app = appId ? await ctx.db.get("applications", appId) : null;
		return app
			? {
					organizationId: app.organizationId,
					name: app.name,
					appName: app.appName,
					serverId: app.serverId,
				}
			: null;
	}
	const composeId = ctx.db.normalizeId("compose", id);
	const compose = composeId ? await ctx.db.get("compose", composeId) : null;
	return compose
		? {
				organizationId: compose.organizationId,
				name: compose.name,
				appName: compose.appName,
				serverId: compose.serverId,
				composeType: compose.composeType,
			}
		: null;
};
