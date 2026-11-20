import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import { traefikGroup } from "../infra/hostJobs";
import { enqueueJob } from "../lib/jobs";
import { nextRunAfter, parseSchedule } from "../platform/lib/cron";
import { partitionOf, requireHostAdmin } from "./lib";

const CLEANUP_BATCH = 100;
export const DEFAULT_CLEANUP_CRON = "0 0 * * *";

// Whether Traefik writes its JSON access log (the "Requests" view).
export const status = query({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { organizationId, serverId }) => {
		await requireHostAdmin(ctx, organizationId, serverId);
		const settings = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		return {
			enabled: settings?.enabled ?? false,
			lastJobId: settings?.lastJobId ?? null,
			cronExpression: settings?.cleanupCron ?? DEFAULT_CLEANUP_CRON,
		};
	},
});

// Rewrites Traefik's static config and restarts it, so it shares the host's
// Traefik job group.
export const toggle = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		enable: v.boolean(),
	},
	handler: async (ctx, { organizationId, serverId, enable }) => {
		const scope = await requireHostAdmin(ctx, organizationId, serverId);
		const jobId = await enqueueJob(ctx, {
			organizationId: scope.organizationId,
			partition: scope.partition,
			group: traefikGroup(scope.partition),
			spec: { kind: "live.accessLogToggle", serverId, enable },
			idempotent: true,
			requestedBy: scope.userId,
		});
		const existing = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (existing) {
			await ctx.db.patch("accessLogSettings", existing._id, {
				enabled: enable,
				lastJobId: jobId,
			});
		} else {
			await ctx.db.insert("accessLogSettings", {
				organizationId: scope.organizationId,
				serverId,
				enabled: enable,
				lastJobId: jobId,
			});
		}
		return jobId;
	},
});

// Sets when the access log is truncated.
export const setCleanupSchedule = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		cronExpression: v.string(),
	},
	handler: async (ctx, { organizationId, serverId, cronExpression }) => {
		const scope = await requireHostAdmin(ctx, organizationId, serverId);
		const cron = cronExpression.trim();
		if (!cron || cron.length > 100) {
			throw new ConvexError("Invalid cron expression");
		}
		try {
			parseSchedule(cron);
		} catch (error) {
			throw new ConvexError(
				error instanceof Error ? error.message : "Invalid cron expression",
			);
		}
		const existing = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		const schedule = { cleanupCron: cron, lastCleanupAt: Date.now() };
		if (existing) {
			await ctx.db.patch("accessLogSettings", existing._id, schedule);
		} else {
			await ctx.db.insert("accessLogSettings", {
				organizationId: scope.organizationId,
				serverId,
				enabled: false,
				...schedule,
			});
		}
	},
});

// Truncates enabled access logs to their last lines whenever their cleanup
// cron came due.
export const enqueueCleanups = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const enabled = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.take(CLEANUP_BATCH);
		for (const settings of enabled) {
			let due: number | null = null;
			try {
				due = nextRunAfter(
					settings.cleanupCron ?? DEFAULT_CLEANUP_CRON,
					undefined,
					settings.lastCleanupAt ?? settings._creationTime,
				);
			} catch {
				continue;
			}
			if (due === null || due > now) continue;
			await ctx.db.patch("accessLogSettings", settings._id, {
				lastCleanupAt: now,
			});
			const partition = partitionOf(settings.serverId);
			const group = `accessLogCleanup:${partition}`;
			const queued = await ctx.db
				.query("jobs")
				.withIndex("by_group_and_status", (q) =>
					q.eq("group", group).eq("status", "queued"),
				)
				.first();
			if (queued) continue;
			await enqueueJob(ctx, {
				organizationId: settings.organizationId,
				partition,
				group,
				spec: { kind: "live.accessLogCleanup", serverId: settings.serverId },
				idempotent: true,
			});
		}
	},
});
