import { ConvexError, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getRootOrganizationId } from "../infra/access";
import type { jobSpec } from "../schema";
import { isTrustedJob } from "./hostPolicy";

export type JobSpec = Infer<typeof jobSpec>;

export const LEASE_MS = 60_000;

// Deploys and builds an organization may have waiting at once: the agent's
// queue is shared by every organization (the root organization is exempt).
export const MAX_QUEUED_BUILDS_PER_ORG = 50;

// Jobs that create or scale a service with the user's bind mounts. Their
// `trusted` flag is always recomputed here, never taken from the caller.
const BIND_MOUNT_KINDS: ReadonlySet<string> = new Set([
	"application.deploy",
	"application.redeploy",
	"application.reload",
	"application.start",
	"application.previewDeploy",
	"application.rollback",
	"databases.deploy",
	"databases.start",
	"databases.reload",
	"databases.rebuild",
]);

const withTrust = async (
	ctx: MutationCtx,
	job: { organizationId: string; spec: JobSpec; requestedBy?: string },
): Promise<JobSpec> => {
	if (!BIND_MOUNT_KINDS.has(job.spec.kind)) return job.spec;
	const { trusted: _ignored, ...spec } = job.spec as JobSpec & {
		trusted?: boolean;
	};
	return (await isTrustedJob(ctx, job.organizationId, job.requestedBy))
		? ({ ...spec, trusted: true } as JobSpec)
		: (spec as JobSpec);
};

export const enqueueJob = async (
	ctx: MutationCtx,
	job: {
		organizationId: string;
		partition: string;
		group: string;
		spec: JobSpec;
		idempotent: boolean;
		usesBuildSlot?: boolean;
		maxAttempts?: number;
		requestedBy?: string;
		idempotencyKey?: string;
	},
): Promise<Id<"jobs">> => {
	if (job.idempotencyKey) {
		const existing = await ctx.db
			.query("jobs")
			.withIndex("by_idempotencyKey", (q) =>
				q.eq("idempotencyKey", job.idempotencyKey),
			)
			.first();
		if (existing) return existing._id;
	}
	if (job.usesBuildSlot) {
		const queued = await ctx.db
			.query("jobs")
			.withIndex("by_organizationId_and_status", (q) =>
				q.eq("organizationId", job.organizationId).eq("status", "queued"),
			)
			.filter((q) => q.eq(q.field("usesBuildSlot"), true))
			.take(MAX_QUEUED_BUILDS_PER_ORG);
		if (
			queued.length >= MAX_QUEUED_BUILDS_PER_ORG &&
			(await getRootOrganizationId(ctx)) !== job.organizationId
		) {
			throw new ConvexError(
				`This organization already has ${MAX_QUEUED_BUILDS_PER_ORG} deployments waiting; wait for them or cancel some`,
			);
		}
	}
	return await ctx.db.insert("jobs", {
		organizationId: job.organizationId,
		partition: job.partition,
		group: job.group,
		spec: await withTrust(ctx, job),
		status: "queued",
		attempts: 0,
		maxAttempts: job.maxAttempts ?? 1,
		idempotent: job.idempotent,
		usesBuildSlot: job.usesBuildSlot ?? false,
		cancelRequested: false,
		requestedBy: job.requestedBy,
		idempotencyKey: job.idempotencyKey,
	});
};
