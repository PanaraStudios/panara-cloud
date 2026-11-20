import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { deleteSecret } from "../lib/secrets";
import { MONITORING_TOKEN_KIND, SANDBOX_ENV_KIND } from "./lib";

const BATCH = 200;
const KEEP_CLOSED_MS = 24 * 60 * 60 * 1000;

export const expireSessions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const stale = await ctx.db
			.query("liveSessions")
			.withIndex("by_status_and_connectBy", (q) =>
				q.eq("status", "pending").lt("connectBy", now),
			)
			.take(BATCH);
		for (const session of stale) {
			await ctx.db.patch("liveSessions", session._id, {
				status: "closed",
				closedAt: now,
				closeReason: "expired",
			});
		}
		const old = await ctx.db
			.query("liveSessions")
			.withIndex("by_closedAt", (q) => q.lt("closedAt", now - KEEP_CLOSED_MS))
			.take(BATCH);
		for (const session of old) {
			if (session.closedAt !== undefined) {
				await ctx.db.delete("liveSessions", session._id);
			}
		}
		if (stale.length === BATCH || old.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.live.cleanup.expireSessions, {});
		}
	},
});

// Call when a server is deleted: drops its sandboxes, monitoring and access
// log settings, and ends its sessions. The host itself is gone, so no jobs.
export const removeForServer = internalMutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const sandboxes = await ctx.db
			.query("sandboxes")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.take(BATCH);
		for (const sandbox of sandboxes) {
			await deleteSecret(ctx, SANDBOX_ENV_KIND, sandbox._id);
			await ctx.db.delete("sandboxes", sandbox._id);
		}
		const monitoring = await ctx.db
			.query("monitoringConfigs")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (monitoring) {
			await deleteSecret(ctx, MONITORING_TOKEN_KIND, monitoring._id);
			await ctx.db.delete("monitoringConfigs", monitoring._id);
		}
		const accessLog = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (accessLog) await ctx.db.delete("accessLogSettings", accessLog._id);
		if (sandboxes.length === BATCH) {
			await ctx.scheduler.runAfter(0, internal.live.cleanup.removeForServer, {
				serverId,
			});
		}
	},
});
