import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { traefikGroup } from "../infra/hostJobs";
import { enqueueJob } from "../lib/jobs";
import { nextRunAfter, parseSchedule } from "../platform/lib/cron";
import { partitionOf, requireHostAdmin } from "./lib";

const CLEANUP_BATCH = 100;
export const DEFAULT_CLEANUP_CRON = "0 0 * * *";

/**
 * The switch as the host has it, and what became of the last press. The
 * stored value changes only when the job that carries a press out succeeded
 * (`applyToggle`), so while that job waits or runs, and when it failed or was
 * cancelled, it still says what the host really does.
 */
export const accessLogState = (
	settings: Pick<Doc<"accessLogSettings">, "enabled"> | null,
	job: Pick<Doc<"jobs">, "status" | "error" | "spec"> | null,
): { enabled: boolean; changing: boolean; failure: string | null } => {
	const enabled = settings?.enabled ?? false;
	if (!job || job.spec.kind !== "live.accessLogToggle") {
		return { enabled, changing: false, failure: null };
	}
	if (job.status === "queued" || job.status === "running") {
		return { enabled, changing: true, failure: null };
	}
	if (job.status === "succeeded") {
		return { enabled, changing: false, failure: null };
	}
	return {
		enabled,
		changing: false,
		failure:
			job.status === "cancelled"
				? "The job was cancelled before it finished."
				: (job.error ?? "The job failed."),
	};
};

// Whether Traefik writes its JSON access log (the "Requests" view).
export const status = query({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { organizationId, serverId }) => {
		await requireHostAdmin(ctx, organizationId, serverId);
		const settings = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		const job = settings?.lastJobId
			? await ctx.db.get("jobs", settings.lastJobId)
			: null;
		return {
			...accessLogState(settings, job),
			lastJobId: settings?.lastJobId ?? null,
			cronExpression: settings?.cleanupCron ?? DEFAULT_CLEANUP_CRON,
		};
	},
});

/**
 * The job that turns the access log on or off succeeded: the switch now says
 * so. Only the job the switch points at may move it; a later press wins.
 */
export const applyToggle = async (
	ctx: MutationCtx,
	job: Pick<Doc<"jobs">, "_id" | "spec">,
) => {
	if (job.spec.kind !== "live.accessLogToggle") return;
	const { serverId, enable } = job.spec;
	const settings = await ctx.db
		.query("accessLogSettings")
		.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
		.unique();
	if (!settings || settings.lastJobId !== job._id) return;
	if (settings.enabled === enable) return;
	await ctx.db.patch("accessLogSettings", settings._id, { enabled: enable });
	await scheduleCleanup(ctx, settings._id);
};

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
		// What was asked for is in the job; the switch moves when it succeeds.
		if (existing) {
			await ctx.db.patch("accessLogSettings", existing._id, {
				lastJobId: jobId,
			});
		} else {
			await ctx.db.insert("accessLogSettings", {
				organizationId: scope.organizationId,
				serverId,
				enabled: false,
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
			await scheduleCleanup(ctx, existing._id);
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

const dueAfterLast = (settings: Doc<"accessLogSettings">) =>
	nextRunAfter(
		settings.cleanupCron ?? DEFAULT_CLEANUP_CRON,
		undefined,
		settings.lastCleanupAt ?? settings._creationTime,
	);

// Queues a truncation when the host's cron came due since the last one.
const cleanupIfDue = async (
	ctx: MutationCtx,
	settings: Doc<"accessLogSettings">,
	now: number,
) => {
	let due: number | null = null;
	try {
		due = dueAfterLast(settings);
	} catch {
		return;
	}
	if (due === null || due > now) return;
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
	if (queued) return;
	await enqueueJob(ctx, {
		organizationId: settings.organizationId,
		partition,
		group,
		spec: { kind: "live.accessLogCleanup", serverId: settings.serverId },
		idempotent: true,
	});
};

const scheduledState = async (
	ctx: MutationCtx,
	scheduledId: Id<"_scheduled_functions"> | undefined,
) =>
	scheduledId
		? (
				await ctx.db.system
					.get("_scheduled_functions", scheduledId)
					.catch(() => null)
			)?.state.kind
		: undefined;

// Schedules the host's next truncation at its cron's next time (now, if one
// was missed), replacing the run scheduled before; none while it is off.
export const scheduleCleanup = async (
	ctx: MutationCtx,
	settingsId: Id<"accessLogSettings">,
) => {
	const settings = await ctx.db.get("accessLogSettings", settingsId);
	if (!settings) return;
	if (
		settings.cleanupScheduledId &&
		(await scheduledState(ctx, settings.cleanupScheduledId)) === "pending"
	) {
		await ctx.scheduler.cancel(settings.cleanupScheduledId);
	}
	let next: number | null = null;
	if (settings.enabled) {
		try {
			next = dueAfterLast(settings);
		} catch {
			next = null;
		}
	}
	const cleanupScheduledId =
		next === null
			? undefined
			: await ctx.scheduler.runAt(
					Math.max(next, Date.now()),
					internal.live.accessLog.runCleanup,
					{ settingsId },
				);
	await ctx.db.patch("accessLogSettings", settingsId, { cleanupScheduledId });
};

// A host's scheduled truncation: queues it if due, then schedules the next.
export const runCleanup = internalMutation({
	args: { settingsId: v.id("accessLogSettings") },
	handler: async (ctx, { settingsId }) => {
		const settings = await ctx.db.get("accessLogSettings", settingsId);
		if (!settings) return;
		if (settings.enabled) await cleanupIfDue(ctx, settings, Date.now());
		await scheduleCleanup(ctx, settingsId);
	},
});

// Hourly backstop for lost scheduler state (e.g. after a snapshot import)
// and for hosts set up before truncations were scheduled: queues what is
// due and schedules the hosts that have no pending run.
export const enqueueCleanups = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const enabled = await ctx.db
			.query("accessLogSettings")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.take(CLEANUP_BATCH);
		for (const settings of enabled) {
			await cleanupIfDue(ctx, settings, now);
			const state = await scheduledState(ctx, settings.cleanupScheduledId);
			if (state !== "pending" && state !== "inProgress") {
				await scheduleCleanup(ctx, settings._id);
			}
		}
	},
});
