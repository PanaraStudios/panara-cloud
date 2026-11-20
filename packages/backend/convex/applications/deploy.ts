import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import {
	requirePermission,
	requireServicePermission,
} from "../lib/permissions";
import { recordServiceEvent } from "../lib/serviceEvents";
import { claimUpload, issueUploadUrl } from "../lib/uploads";
import {
	applicationGroup,
	applicationOwner,
	buildPartition,
	deployPartition,
	enqueueApplicationJob,
	enqueueDeployment,
	isSafeBuildPath,
	requireApplication,
} from "./lib";

const MAX_DROP_BYTES = 200 * 1024 * 1024;
const DEPLOYMENT_HISTORY = 50;
const CLEAR_BATCH = 200;
const LOG_PURGE_BATCH = 500;

const assertDeployable = (app: Doc<"applications">) => {
	if (!app.source) throw new ConvexError("Configure a source before deploying");
	if (app.source.type === "drop" && !app.source.storageId) {
		throw new ConvexError("Upload a zip file before deploying");
	}
};

// Shared by the UI, webhooks and git events.
export const queueDeploy = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
	input: {
		title?: string;
		description?: string;
		commit?: { sha: string; message?: string };
		requestedBy?: string;
	},
) => {
	assertDeployable(app);
	return await enqueueDeployment(ctx, {
		organizationId: app.organizationId,
		partition: buildPartition(app),
		group: applicationGroup(app._id),
		spec: { kind: "application.deploy", applicationId: app._id },
		target: applicationOwner(app._id),
		title: input.title || "Manual deployment",
		description: input.description,
		commit: input.commit,
		requestedBy: input.requestedBy,
	});
};

// Handlers are exported so `serviceEvents.applyPending` starts the same jobs
// with the same permission checks.
export const startDeploy = async (
	ctx: MutationCtx,
	{
		applicationId,
		title,
		description,
	}: {
		applicationId: Id<"applications">;
		title?: string;
		description?: string;
	},
) => {
	const { app, userId } = await requireApplication(
		ctx,
		applicationId,
		"deployment",
		"create",
	);
	return await queueDeploy(ctx, app, {
		title,
		description,
		requestedBy: userId,
	});
};

export const deploy = mutation({
	args: {
		applicationId: v.id("applications"),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: startDeploy,
});

export const startRedeploy = async (
	ctx: MutationCtx,
	{
		applicationId,
		rebuild,
		title,
		description,
	}: {
		applicationId: Id<"applications">;
		rebuild?: boolean;
		title?: string;
		description?: string;
	},
) => {
	const { app, userId } = await requireApplication(
		ctx,
		applicationId,
		"deployment",
		"create",
	);
	assertDeployable(app);
	const withBuild = rebuild ?? false;
	if (!withBuild && !app.lastImage && app.source?.type !== "docker") {
		throw new ConvexError("Deploy the application once before redeploying");
	}
	return await enqueueDeployment(ctx, {
		organizationId: app.organizationId,
		partition: withBuild ? buildPartition(app) : deployPartition(app),
		group: applicationGroup(applicationId),
		spec: {
			kind: "application.redeploy",
			applicationId,
			rebuild: withBuild,
		},
		target: applicationOwner(applicationId),
		title: title || (withBuild ? "Rebuild deployment" : "Redeploy"),
		description,
		requestedBy: userId,
	});
};

export const redeploy = mutation({
	args: {
		applicationId: v.id("applications"),
		rebuild: v.optional(v.boolean()),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: startRedeploy,
});

const operationHandler =
	(kind: "reload" | "start" | "stop") =>
	async (
		ctx: MutationCtx,
		{ applicationId }: { applicationId: Id<"applications"> },
	): Promise<Id<"jobs">> => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"deployment",
			"create",
		);
		await recordServiceEvent(
			ctx,
			"application",
			app,
			`lifecycle.${kind}`,
			userId,
		);
		return await enqueueApplicationJob(ctx, {
			organizationId: app.organizationId,
			partition: deployPartition(app),
			group: applicationGroup(applicationId),
			spec: { kind: `application.${kind}` as const, applicationId },
			requestedBy: userId,
		});
	};

const serviceOperation = (kind: "reload" | "start" | "stop") =>
	mutation({
		args: { applicationId: v.id("applications") },
		handler: operationHandler(kind),
	});

export const startReload = operationHandler("reload");
// Re-applies the service spec (env, mounts, resources) with the current image.
export const reload = serviceOperation("reload");
export const start = serviceOperation("start");
export const stop = serviceOperation("stop");

const cancelDeployJobs = async (
	ctx: MutationCtx,
	applicationId: Id<"applications">,
	statuses: readonly ("queued" | "running")[],
) => {
	const group = applicationGroup(applicationId);
	let cancelled = 0;
	for (const status of statuses) {
		const jobs = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", group).eq("status", status),
			)
			.take(50);
		for (const job of jobs) {
			if (
				job.spec.kind !== "application.deploy" &&
				job.spec.kind !== "application.redeploy"
			) {
				continue;
			}
			await ctx.db.patch(
				"jobs",
				job._id,
				status === "queued"
					? {
							status: "cancelled",
							cancelRequested: true,
							finishedAt: Date.now(),
						}
					: { cancelRequested: true },
			);
			cancelled++;
		}
	}
	return cancelled;
};

// Stops only this application's builds, not every build on the host.
export const cancelDeployments = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		await requireApplication(ctx, applicationId, "deployment", "cancel");
		return await cancelDeployJobs(ctx, applicationId, ["queued", "running"]);
	},
});

// Drops deployments that have not started yet.
export const cleanQueues = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		await requireApplication(ctx, applicationId, "deployment", "cancel");
		return {
			cancelled: await cancelDeployJobs(ctx, applicationId, ["queued"]),
		};
	},
});

// The agent kills the running build when its job is cancelled.
export const killBuild = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		await requireApplication(ctx, applicationId, "deployment", "cancel");
		return {
			cancelled: await cancelDeployJobs(ctx, applicationId, ["running"]),
		};
	},
});

// Deletes finished deployments and their logs,
// keeping queued/running ones and the latest successful deployment.
export const clearDeployments = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		await requireApplication(ctx, applicationId, "deployment", "create");
		const rows = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "application").eq("target.id", applicationId),
			)
			.order("desc")
			.take(CLEAR_BATCH);
		let keptLatestSuccess = false;
		const removed = new Set<Id<"deployments">>();
		const jobIds: Id<"jobs">[] = [];
		for (const row of rows) {
			const job = await ctx.db.get("jobs", row.jobId);
			if (job?.status === "queued" || job?.status === "running") continue;
			if (job?.status === "succeeded" && !keptLatestSuccess) {
				keptLatestSuccess = true;
				continue;
			}
			await ctx.db.delete("deployments", row._id);
			removed.add(row._id);
			jobIds.push(row.jobId);
		}
		if (removed.size > 0) {
			const rollbacks = await ctx.db
				.query("applicationRollbacks")
				.withIndex("by_applicationId_and_version", (q) =>
					q.eq("applicationId", applicationId),
				)
				.take(100);
			for (const rollback of rollbacks) {
				if (rollback.deploymentId && removed.has(rollback.deploymentId)) {
					await ctx.db.patch("applicationRollbacks", rollback._id, {
						deploymentId: undefined,
					});
				}
			}
			await ctx.scheduler.runAfter(
				0,
				internal.applications.deploy.purgeJobLogs,
				{ jobIds },
			);
		}
		return { removed: removed.size };
	},
});

export const purgeJobLogs = internalMutation({
	args: { jobIds: v.array(v.id("jobs")) },
	handler: async (ctx, { jobIds }) => {
		const [jobId, ...rest] = jobIds;
		if (!jobId) return;
		const chunks = await ctx.db
			.query("jobLogChunks")
			.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
			.take(LOG_PURGE_BATCH);
		for (const chunk of chunks) await ctx.db.delete("jobLogChunks", chunk._id);
		const next = chunks.length === LOG_PURGE_BATCH ? jobIds : rest;
		if (next.length > 0) {
			await ctx.scheduler.runAfter(
				0,
				internal.applications.deploy.purgeJobLogs,
				{ jobIds: next },
			);
		}
	},
});

// Base of the deploy webhook URLs (`<base>/<token>`, `<base>/compose/<token>`):
// they are served by the Convex site, not the web app.
export const webhookBaseUrl = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "service", "create");
		return `${(process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "")}/api/deploy`;
	},
});

export const generateDropUploadUrl = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { userId } = await requireApplication(
			ctx,
			applicationId,
			"deployment",
			"create",
		);
		return await issueUploadUrl(ctx, userId, `drop:${applicationId}`);
	},
});

// Deploys an uploaded zip: it was uploaded with generateDropUploadUrl;
// the agent downloads and unpacks it on the build server.
export const dropDeploy = mutation({
	args: {
		applicationId: v.id("applications"),
		storageId: v.id("_storage"),
		buildPath: v.optional(v.string()),
	},
	handler: async (ctx, { applicationId, storageId, buildPath }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"deployment",
			"create",
		);
		const file = await claimUpload(
			ctx,
			userId,
			`drop:${applicationId}`,
			storageId,
		);
		if (file.size > MAX_DROP_BYTES) {
			await ctx.storage.delete(storageId);
			throw new ConvexError("The zip file is larger than 200 MB");
		}
		const path = (buildPath ?? "").trim().replace(/^\/+/, "");
		if (!isSafeBuildPath(path)) {
			throw new ConvexError("Invalid build path");
		}
		if (
			app.source?.type === "drop" &&
			app.source.storageId &&
			app.source.storageId !== storageId
		) {
			await ctx.storage.delete(app.source.storageId);
		}
		const updated = {
			...app,
			source: { type: "drop" as const, buildPath: path, storageId },
			gitProviderId: undefined,
		};
		await ctx.db.patch("applications", applicationId, {
			source: updated.source,
			gitProviderId: undefined,
		});
		return await queueDeploy(ctx, updated, { requestedBy: userId });
	},
});

export const listDeployments = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return [];
		await requireServicePermission(ctx, app, "deployment", "read");
		return await withJobs(
			ctx,
			await ctx.db
				.query("deployments")
				.withIndex("by_target", (q) =>
					q.eq("target.kind", "application").eq("target.id", applicationId),
				)
				.order("desc")
				.take(DEPLOYMENT_HISTORY),
		);
	},
});

export const listPreviewDeployments = query({
	args: { previewId: v.id("applicationPreviews") },
	handler: async (ctx, { previewId }) => {
		const preview = await ctx.db.get("applicationPreviews", previewId);
		if (!preview) return [];
		await requireServicePermission(
			ctx,
			{ _id: preview.applicationId, organizationId: preview.organizationId },
			"deployment",
			"read",
		);
		return await withJobs(
			ctx,
			await ctx.db
				.query("deployments")
				.withIndex("by_target", (q) =>
					q.eq("target.kind", "preview").eq("target.id", previewId),
				)
				.order("desc")
				.take(DEPLOYMENT_HISTORY),
		);
	},
});

const withJobs = async (ctx: QueryCtx, deployments: Doc<"deployments">[]) =>
	Promise.all(
		deployments.map(async (deployment) => {
			const job = await ctx.db.get("jobs", deployment.jobId);
			return {
				...deployment,
				status: job?.status ?? "failed",
				error: job?.error,
				startedAt: job?.startedAt,
				finishedAt: job?.finishedAt,
			};
		}),
	);

export const removeDeployment = mutation({
	args: { deploymentId: v.id("deployments") },
	handler: async (ctx, { deploymentId }) => {
		const deployment = await ctx.db.get("deployments", deploymentId);
		if (!deployment) return;
		if (
			deployment.target.kind !== "application" &&
			deployment.target.kind !== "preview"
		) {
			await requirePermission(
				ctx,
				deployment.organizationId,
				"deployment",
				"cancel",
			);
			throw new ConvexError("Not an application deployment");
		}
		const preview =
			deployment.target.kind === "preview"
				? await ctx.db.get(
						"applicationPreviews",
						deployment.target.id as Id<"applicationPreviews">,
					)
				: null;
		await requireServicePermission(
			ctx,
			{
				_id: preview?.applicationId ?? deployment.target.id,
				organizationId: deployment.organizationId,
			},
			"deployment",
			"cancel",
		);
		const job = await ctx.db.get("jobs", deployment.jobId);
		if (job && (job.status === "queued" || job.status === "running")) {
			throw new ConvexError("Cancel the deployment before removing it");
		}
		const rollback = await ctx.db
			.query("applicationRollbacks")
			.withIndex("by_applicationId_and_version", (q) =>
				q.eq("applicationId", deployment.target.id as Id<"applications">),
			)
			.take(100);
		for (const row of rollback) {
			if (row.deploymentId === deploymentId) {
				await ctx.db.patch("applicationRollbacks", row._id, {
					deploymentId: undefined,
				});
			}
		}
		await ctx.db.delete("deployments", deploymentId);
	},
});
