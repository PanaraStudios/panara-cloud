import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../_generated/server";

// The panel host's public address lives in infra's instance-wide
// webServerSettings (serverIp).
export const panelServerIp = async (ctx: QueryCtx): Promise<string> => {
	const settings = await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();
	return settings?.serverIp ?? "";
};

export const serverIpFor = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: string | undefined,
): Promise<string> => {
	if (!serverId) return (await panelServerIp(ctx)) || "127.0.0.1";
	const id = ctx.db.normalizeId("servers", serverId);
	const server = id ? await ctx.db.get("servers", id) : null;
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
	return server.ipAddress;
};
