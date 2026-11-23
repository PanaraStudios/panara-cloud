import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Role } from "../lib/access";
import { enqueueJob, type JobSpec } from "../lib/jobs";
import type { snapshotKind } from "../tables/infra";
import type { HostScope } from "./access";

export type SnapshotKind = Infer<typeof snapshotKind>;

const ADMIN_SNAPSHOTS: ReadonlySet<SnapshotKind> = new Set([
	"audit",
	"traefik",
	"fail2ban",
	"exposedPorts",
	"pendingUpdates",
	"sshSecurity",
	"activity",
	"gpu",
	"validate",
	"health",
	"panel",
	"vector",
]);

// Host views gated behind docker.read (members need the
// canAccessToDocker grant). Service pages still read the containers snapshot
// to find a service's containers, so it stays open to members.
export const DOCKER_SNAPSHOTS: ReadonlySet<SnapshotKind> = new Set([
	"images",
	"volumes",
	"networks",
	"diskUsage",
	"buildCache",
	"swarmNodes",
	"swarmServices",
]);

// What a `hostSnapshot` live session can keep fresh: Docker listings the agent
// reads with the host alone (the others need a job's context).
export const LIVE_SNAPSHOTS: ReadonlySet<SnapshotKind> = new Set([
	"containers",
	"images",
	"volumes",
	"networks",
	"diskUsage",
	"buildCache",
	"swarmNodes",
	"swarmServices",
]);

export const LIVE_SNAPSHOT_INTERVAL = { min: 5_000, max: 300_000 } as const;

export const snapshotRole = (kind: SnapshotKind): Role =>
	ADMIN_SNAPSHOTS.has(kind) ? "admin" : "member";

export const inspectGroup = (partition: string, kind: SnapshotKind) =>
	`inspect:${partition}:${kind}`;

// Host-level jobs that change Traefik or the host setup share one group so
// they never interleave on the same host.
export const traefikGroup = (partition: string) => `traefik:${partition}`;

export const enqueueHostJob = (
	ctx: MutationCtx,
	scope: Pick<HostScope, "organizationId" | "partition" | "userId">,
	group: string,
	spec: JobSpec,
	options: { idempotent?: boolean; maxAttempts?: number } = {},
): Promise<Id<"jobs">> =>
	enqueueJob(ctx, {
		organizationId: scope.organizationId,
		partition: scope.partition,
		group,
		spec,
		idempotent: options.idempotent ?? false,
		maxAttempts: options.maxAttempts ?? 1,
		requestedBy: scope.userId,
	});

// Collapses repeated refresh requests into the job that is already waiting.
export const enqueueInspect = async (
	ctx: MutationCtx,
	scope: Pick<
		HostScope,
		"organizationId" | "partition" | "userId" | "serverId"
	>,
	what: SnapshotKind,
): Promise<Id<"jobs">> => {
	const group = inspectGroup(scope.partition, what);
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.first();
	if (queued) return queued._id;
	return await enqueueHostJob(
		ctx,
		scope,
		group,
		{ kind: "infra.inspect", serverId: scope.serverId, what },
		{ idempotent: true, maxAttempts: 2 },
	);
};

export const enqueueOp = async (
	ctx: MutationCtx,
	scope: Pick<HostScope, "organizationId" | "partition" | "userId">,
	group: string,
	spec: JobSpec,
	options: { restricted: boolean; input?: string; idempotent?: boolean },
): Promise<Id<"jobs">> => {
	const jobId = await enqueueHostJob(ctx, scope, group, spec, {
		idempotent: options.idempotent,
	});
	await ctx.db.insert("infraOps", {
		organizationId: scope.organizationId,
		jobId,
		restricted: options.restricted,
		input: options.input,
	});
	return jobId;
};
