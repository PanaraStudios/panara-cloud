import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	internalMutation,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import {
	type Access,
	canAccessService,
	hasPermission,
	requirePermission,
	resolvePermissions,
} from "./lib/permissions";

const RECENT_JOBS = 50;
const MAX_LOG_WINDOW = 200;
const REAP_BATCH = 50;
const DEPLOYMENT_HISTORY = 50;

// Deployment targets that run on a host rather than in a service: only
// admins read their history.
const HOST_TARGETS = new Set(["server", "panelBackup", "panelRestore"]);

// Job groups named after the service they work on (`<kind>:<id>`).
const SERVICE_GROUPS = new Set([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

const scheduleServiceId = async (ctx: QueryCtx, id: string) => {
	const scheduleId = ctx.db.normalizeId("schedules", id);
	const schedule = scheduleId
		? await ctx.db.get("schedules", scheduleId)
		: null;
	if (schedule?.target.kind === "application") {
		return schedule.target.applicationId;
	}
	if (schedule?.target.kind === "compose") return schedule.target.composeId;
	return null;
};

const previewServiceId = async (ctx: QueryCtx, id: string) => {
	const previewId = ctx.db.normalizeId("applicationPreviews", id);
	const preview = previewId
		? await ctx.db.get("applicationPreviews", previewId)
		: null;
	return preview?.applicationId ?? null;
};

// The service a job works on; null for host-level work.
const jobServiceId = async (
	ctx: QueryCtx,
	group: string,
): Promise<string | null> => {
	const separator = group.indexOf(":");
	if (separator < 0) return null;
	const kind = group.slice(0, separator);
	const id = group.slice(separator + 1);
	if (SERVICE_GROUPS.has(kind)) return id;
	if (kind === "preview") return await previewServiceId(ctx, id);
	if (kind === "schedule") return await scheduleServiceId(ctx, id);
	return null;
};

// Members reach the jobs of services they were given (their deployment
// permissions) and the jobs they started themselves; host-level jobs are for
// admins.
const canUseJob = async (
	ctx: QueryCtx,
	access: Access,
	job: Doc<"jobs">,
	action: "read" | "cancel",
): Promise<boolean> => {
	if (!access.scope) return true;
	if (job.requestedBy === access.userId) return true;
	if (!hasPermission(access, "deployment", action)) return false;
	const serviceId = await jobServiceId(ctx, job.group);
	return serviceId !== null && canAccessService(access, serviceId);
};

const requireJob = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	action: "read" | "cancel",
) => {
	const access = await resolvePermissions(ctx, job.organizationId);
	if (!(await canUseJob(ctx, access, job, action))) {
		throw new ConvexError("You don't have access to this job");
	}
	return access;
};

// The service a deployment target belongs to, and the permission reading
// its history needs; null for host-level targets.
const targetService = async (
	ctx: QueryCtx,
	target: { kind: string; id: string },
): Promise<{
	serviceId: string | null;
	resource: "deployment" | "backup" | "volumeBackup";
}> => {
	switch (target.kind) {
		case "application":
		case "compose":
		case "database":
			return { serviceId: target.id, resource: "deployment" };
		case "preview":
			return {
				serviceId: await previewServiceId(ctx, target.id),
				resource: "deployment",
			};
		case "schedule":
			return {
				serviceId: await scheduleServiceId(ctx, target.id),
				resource: "deployment",
			};
		case "databaseBackup": {
			const id = ctx.db.normalizeId("databaseBackups", target.id);
			const backup = id ? await ctx.db.get("databaseBackups", id) : null;
			return { serviceId: backup?.owner.id ?? null, resource: "backup" };
		}
		case "volumeBackup": {
			const id = ctx.db.normalizeId("volumeBackups", target.id);
			const backup = id ? await ctx.db.get("volumeBackups", id) : null;
			return {
				serviceId: backup?.owner.id ?? null,
				resource: "volumeBackup",
			};
		}
		default:
			return { serviceId: null, resource: "deployment" };
	}
};

export const listRecent = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"deployment",
			"read",
		);
		const jobs = await ctx.db
			.query("jobs")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(RECENT_JOBS);
		if (!access.scope) return jobs;
		const visible = await Promise.all(
			jobs.map((job) => canUseJob(ctx, access, job, "read")),
		);
		return jobs.filter((_, index) => visible[index]);
	},
});

export const get = query({
	args: { jobId: v.id("jobs") },
	handler: async (ctx, { jobId }) => {
		const job = await ctx.db.get("jobs", jobId);
		if (!job) return null;
		await requireJob(ctx, job, "read");
		return job;
	},
});

// Windowed so a live subscription only re-sends the tail, never the full log.
export const logs = query({
	args: {
		jobId: v.id("jobs"),
		afterSeq: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { jobId, afterSeq, limit }) => {
		const job = await ctx.db.get("jobs", jobId);
		if (!job) return [];
		await requireJob(ctx, job, "read");
		const take = Math.min(Math.max(limit ?? MAX_LOG_WINDOW, 1), MAX_LOG_WINDOW);
		return await ctx.db
			.query("jobLogChunks")
			.withIndex("by_jobId_and_seq", (q) =>
				afterSeq === undefined
					? q.eq("jobId", jobId)
					: q.eq("jobId", jobId).gt("seq", afterSeq),
			)
			.take(take);
	},
});

// Deploy history of any target (`deployments.target`) in the caller's
// organization, newest first, with the status of each run's job.
export const deployments = query({
	args: {
		organizationId: v.string(),
		target: v.object({ kind: v.string(), id: v.string() }),
	},
	handler: async (ctx, { organizationId, target }) => {
		const access = await resolvePermissions(ctx, organizationId);
		if (access.scope) {
			const { serviceId, resource } = HOST_TARGETS.has(target.kind)
				? { serviceId: null, resource: "deployment" as const }
				: await targetService(ctx, target);
			if (
				serviceId === null ||
				!hasPermission(access, resource, "read") ||
				!canAccessService(access, serviceId)
			) {
				throw new ConvexError("You don't have access to this history");
			}
		}
		const rows = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", target.kind).eq("target.id", target.id),
			)
			.order("desc")
			.take(DEPLOYMENT_HISTORY);
		return await Promise.all(
			rows
				.filter((row) => row.organizationId === organizationId)
				.map(async (row) => {
					const job = await ctx.db.get("jobs", row.jobId);
					return {
						...row,
						status: job?.status ?? ("failed" as const),
						error: job?.error,
						startedAt: job?.startedAt,
						finishedAt: job?.finishedAt,
						partition: job?.partition,
					};
				}),
		);
	},
});

export const cancel = mutation({
	args: { jobId: v.id("jobs") },
	handler: async (ctx, { jobId }) => {
		const job = await ctx.db.get("jobs", jobId);
		if (!job) throw new ConvexError("Job not found");
		await requireJob(ctx, job, "cancel");
		if (job.status === "queued") {
			await ctx.db.patch("jobs", jobId, {
				status: "cancelled",
				cancelRequested: true,
				finishedAt: Date.now(),
			});
		} else if (job.status === "running") {
			await ctx.db.patch("jobs", jobId, { cancelRequested: true });
		}
	},
});

// Lease expiry means the agent died or lost connectivity mid-job.
export const reapExpiredLeases = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query("jobLeases")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
			.take(REAP_BATCH);
		for (const lease of expired) {
			const job = await ctx.db.get("jobs", lease.jobId);
			await ctx.db.delete("jobLeases", lease._id);
			if (job?.status !== "running") continue;
			const retry =
				job.idempotent &&
				!job.cancelRequested &&
				job.attempts < job.maxAttempts;
			await ctx.db.patch(
				"jobs",
				job._id,
				retry
					? { status: "queued", claimedBy: undefined, startedAt: undefined }
					: {
							status: job.cancelRequested ? "cancelled" : "failed",
							error: "Agent stopped responding (lease expired)",
							finishedAt: now,
						},
			);
		}
	},
});
