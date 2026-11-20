import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireMember } from "../lib/access";
import { requirePermission } from "../lib/permissions";
import { snapshotKind } from "../tables/infra";
import { requireHostAccess } from "./access";
import {
	DOCKER_SNAPSHOTS,
	enqueueInspect,
	inspectGroup,
	type SnapshotKind,
	snapshotRole,
} from "./hostJobs";

const requireSnapshotAccess = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
	kind: SnapshotKind,
) => {
	const scope = await requireHostAccess(ctx, serverId, snapshotRole(kind));
	if (DOCKER_SNAPSHOTS.has(kind)) {
		await requirePermission(ctx, scope.organizationId, "docker", "read");
	}
	return scope;
};

// Live host state follows one pattern: the UI subscribes to `get` and calls
// `refresh`, which queues an `infra.inspect` job; the agent overwrites the
// snapshot row when it finishes. `pendingJobId` lets the UI show progress.
export const get = query({
	args: { serverId: v.optional(v.id("servers")), kind: snapshotKind },
	handler: async (ctx, { serverId, kind }) => {
		const scope = await requireSnapshotAccess(ctx, serverId, kind);
		const snapshot = await ctx.db
			.query("infraSnapshots")
			.withIndex("by_serverId_and_kind", (q) =>
				q.eq("serverId", serverId).eq("kind", kind),
			)
			.unique();
		const group = inspectGroup(scope.partition, kind);
		const pending =
			(await ctx.db
				.query("jobs")
				.withIndex("by_group_and_status", (q) =>
					q.eq("group", group).eq("status", "running"),
				)
				.first()) ??
			(await ctx.db
				.query("jobs")
				.withIndex("by_group_and_status", (q) =>
					q.eq("group", group).eq("status", "queued"),
				)
				.first());
		return {
			data: snapshot?.data ?? null,
			error: snapshot?.error ?? null,
			refreshedAt: snapshot?.refreshedAt ?? null,
			pendingJobId: pending?._id ?? null,
		};
	},
});

export const refresh = mutation({
	args: { serverId: v.optional(v.id("servers")), kind: snapshotKind },
	handler: async (ctx, { serverId, kind }) => {
		const scope = await requireSnapshotAccess(ctx, serverId, kind);
		return await enqueueInspect(ctx, scope, kind);
	},
});

// Result of a one-off job (inspect, Traefik file read, join tokens).
export const opResult = query({
	args: { jobId: v.id("jobs") },
	handler: async (ctx, { jobId }) => {
		const op = await ctx.db
			.query("infraOps")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		if (!op) return null;
		const { userId, role } = await requireMember(ctx, op.organizationId);
		const job = await ctx.db.get("jobs", jobId);
		// Restricted results (join tokens, Traefik files) go to admins and to
		// the member whose permission let them request it.
		if (op.restricted && role === "member" && job?.requestedBy !== userId) {
			throw new ConvexError("Requires the admin role");
		}
		return {
			status: job?.status ?? null,
			result: op.result ?? null,
			error: op.error ?? job?.error ?? null,
		};
	},
});
