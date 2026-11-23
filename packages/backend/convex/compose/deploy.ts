import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { listMounts } from "../lib/mounts";
import { requireServicePermission } from "../lib/permissions";
import { assertDeployed } from "../lib/serviceActivity";
import { recordServiceEvent } from "../lib/serviceEvents";
import type { composePreviewOverrides } from "../tables/compose";
import {
	defaultCommand as buildDefaultCommand,
	cancelQueuedJobs,
	enqueueComposeJob,
	enqueueDeploy,
	generateSuffix,
	group,
	loadCompose,
	owner,
	validateSuffix,
} from "./lib";

type ComposePreviewOverrides = typeof composePreviewOverrides.type;

const MAX_DEPLOYMENTS = 50;
const CLEAR_BATCH = 200;
const OPS_TTL_MS = 24 * 60 * 60 * 1000;
const GC_BATCH = 200;

const deployArgs = {
	composeId: v.id("compose"),
	title: v.optional(v.string()),
	description: v.optional(v.string()),
	freshVolumes: v.optional(v.boolean()),
};
const deployArgsObject = v.object(deployArgs);

// Exported so `serviceEvents.applyPending` starts the same job with the same
// permission checks.
export const startDeploy = async (
	ctx: MutationCtx,
	{ composeId, ...input }: typeof deployArgsObject.type,
) => {
	const { compose, userId } = await loadCompose(
		ctx,
		composeId,
		"deployment",
		"create",
	);
	return await enqueueDeploy(ctx, compose, {
		kind: "compose.deploy",
		...input,
		requestedBy: userId,
	});
};

export const deploy = mutation({
	args: deployArgs,
	handler: startDeploy,
});

export const redeploy = mutation({
	args: deployArgs,
	handler: async (ctx, { composeId, ...input }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"deployment",
			"create",
		);
		return await enqueueDeploy(ctx, compose, {
			kind: "compose.redeploy",
			...input,
			requestedBy: userId,
		});
	},
});

export const start = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"deployment",
			"create",
		);
		await assertDeployed(ctx, compose, group(composeId));
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			"lifecycle.start",
			userId,
		);
		return await enqueueComposeJob(
			ctx,
			compose,
			{ kind: "compose.start", composeId },
			{ requestedBy: userId, idempotent: true, maxAttempts: 2 },
		);
	},
});

export const stop = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"deployment",
			"create",
		);
		await assertDeployed(ctx, compose, group(composeId));
		await recordServiceEvent(ctx, "compose", compose, "lifecycle.stop", userId);
		return await enqueueComposeJob(
			ctx,
			compose,
			{ kind: "compose.stop", composeId },
			{ requestedBy: userId, idempotent: true, maxAttempts: 2 },
		);
	},
});

export const cleanQueues = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		await loadCompose(ctx, composeId, "deployment", "create");
		return { cancelled: await cancelQueuedJobs(ctx, composeId) };
	},
});

// Cancelling the running deploy job makes the agent
// kill the deploy script's whole process group (docker compose build/up and
// everything it spawned); see runScript in apps/agent/src/compose.
export const killBuild = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		await loadCompose(ctx, composeId, "deployment", "cancel");
		const running = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", group(composeId)).eq("status", "running"),
			)
			.take(20);
		let cancelled = 0;
		for (const job of running) {
			if (
				job.spec.kind !== "compose.deploy" &&
				job.spec.kind !== "compose.redeploy"
			) {
				continue;
			}
			await ctx.db.patch("jobs", job._id, { cancelRequested: true });
			cancelled++;
		}
		return { cancelled };
	},
});

const startOp = async (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	kind: "loadServices" | "convert",
	fetch: boolean,
	requestedBy: string,
	overrides?: ComposePreviewOverrides,
): Promise<{ opId: Id<"composeOps">; jobId: Id<"jobs"> }> => {
	const opId = await ctx.db.insert("composeOps", {
		organizationId: compose.organizationId,
		composeId: compose._id,
		kind,
	});
	const jobId = await enqueueComposeJob(
		ctx,
		compose,
		kind === "loadServices"
			? { kind: "compose.loadServices", composeId: compose._id, opId, fetch }
			: {
					kind: "compose.convert",
					composeId: compose._id,
					opId,
					fetch,
					...(overrides ? { overrides } : {}),
				},
		{ requestedBy, idempotent: true, maxAttempts: 2 },
	);
	await ctx.db.patch("composeOps", opId, { jobId });
	return { opId, jobId };
};

// Lists the compose file's services ("fetch" clones the source again; "cache" reads
// what is on the host) and refreshes the source (fetch: true). The service names
// land on the compose row; failures on the op.
export const loadServices = mutation({
	args: { composeId: v.id("compose"), fetch: v.optional(v.boolean()) },
	handler: async (ctx, { composeId, fetch }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"read",
		);
		return await startOp(ctx, compose, "loadServices", fetch ?? true, userId);
	},
});

// Converted, randomized and isolated-deployment previews: the compose file as the next deploy would write it, or with the
// randomize / isolated deployment values of an unsaved form. A randomize
// preview without a suffix uses a random one.
export const convert = mutation({
	args: {
		composeId: v.id("compose"),
		fetch: v.optional(v.boolean()),
		randomize: v.optional(v.boolean()),
		suffix: v.optional(v.string()),
		isolatedDeployment: v.optional(v.boolean()),
	},
	handler: async (ctx, { composeId, fetch, ...preview }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		const overrides: ComposePreviewOverrides = {};
		if (preview.isolatedDeployment !== undefined) {
			overrides.isolatedDeployment = preview.isolatedDeployment;
		}
		if (preview.randomize !== undefined) {
			overrides.randomize = preview.randomize;
		}
		if (preview.suffix !== undefined) {
			overrides.suffix = validateSuffix(preview.suffix.trim());
		}
		if (overrides.randomize && !overrides.suffix) {
			overrides.suffix = generateSuffix();
		}
		return await startOp(
			ctx,
			compose,
			"convert",
			fetch ?? false,
			userId,
			Object.keys(overrides).length > 0 ? overrides : undefined,
		);
	},
});

export const getOp = query({
	args: { opId: v.id("composeOps") },
	handler: async (ctx, { opId }) => {
		const op = await ctx.db.get("composeOps", opId);
		if (!op) return null;
		await loadCompose(ctx, op.composeId, "service", "read");
		return op;
	},
});

export const listDeployments = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		await loadCompose(ctx, composeId, "deployment", "read");
		return await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "compose").eq("target.id", composeId),
			)
			.order("desc")
			.take(MAX_DEPLOYMENTS);
	},
});

// Deletes finished deployments and their logs, keeping queued/running ones and the latest successful deployment.
export const clearDeployments = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const compose = await ctx.db.get("compose", composeId);
		if (!compose) throw new ConvexError("Compose not found");
		await requireServicePermission(ctx, compose, "deployment", "create");
		const rows = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "compose").eq("target.id", composeId),
			)
			.order("desc")
			.take(CLEAR_BATCH);
		let keptLatestSuccess = false;
		const jobIds: Id<"jobs">[] = [];
		for (const row of rows) {
			const job = await ctx.db.get("jobs", row.jobId);
			if (job?.status === "queued" || job?.status === "running") continue;
			if (job?.status === "succeeded" && !keptLatestSuccess) {
				keptLatestSuccess = true;
				continue;
			}
			await ctx.db.delete("deployments", row._id);
			jobIds.push(row.jobId);
		}
		if (jobIds.length > 0) {
			await ctx.scheduler.runAfter(
				0,
				internal.applications.deploy.purgeJobLogs,
				{ jobIds },
			);
		}
		return { removed: jobIds.length };
	},
});

// Removes one compose deployment.
export const removeDeployment = mutation({
	args: { deploymentId: v.id("deployments") },
	handler: async (ctx, { deploymentId }) => {
		const deployment = await ctx.db.get("deployments", deploymentId);
		if (!deployment) return;
		if (deployment.target.kind !== "compose") {
			throw new ConvexError("Not a compose deployment");
		}
		await requireServicePermission(
			ctx,
			{ _id: deployment.target.id, organizationId: deployment.organizationId },
			"deployment",
			"cancel",
		);
		const job = await ctx.db.get("jobs", deployment.jobId);
		if (job && (job.status === "queued" || job.status === "running")) {
			throw new ConvexError("Cancel the deployment before removing it");
		}
		await ctx.db.delete("deployments", deploymentId);
		await ctx.scheduler.runAfter(0, internal.applications.deploy.purgeJobLogs, {
			jobIds: [deployment.jobId],
		});
	},
});

export const defaultCommand = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose } = await loadCompose(ctx, composeId, "service", "create");
		const mounts = await listMounts(ctx, owner(composeId));
		return buildDefaultCommand(compose, mounts.length > 0);
	},
});

export const gcOps = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - OPS_TTL_MS;
		const old = await ctx.db
			.query("composeOps")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(GC_BATCH);
		for (const op of old) await ctx.db.delete("composeOps", op._id);
		if (old.length === GC_BATCH) {
			await ctx.scheduler.runAfter(0, internal.compose.deploy.gcOps, {});
		}
	},
});

export const enqueueFromWebhook = internalMutation({
	args: {
		composeId: v.id("compose"),
		title: v.string(),
		description: v.optional(v.string()),
		commitSha: v.optional(v.string()),
	},
	handler: async (ctx, { composeId, title, description, commitSha }) => {
		const compose = await ctx.db.get("compose", composeId);
		if (!compose) throw new ConvexError("Compose not found");
		return await enqueueDeploy(ctx, compose, {
			kind: "compose.deploy",
			title,
			description,
			commit: commitSha ? { sha: commitSha, message: title } : undefined,
		});
	},
});
