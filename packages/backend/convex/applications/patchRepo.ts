// Browsing an application's repository to create patches: the agent clones
// it into /etc/panara-cloud/patch-repos/application/<appName> on the build server
// and reports the file tree or one file's content into `applicationOps`.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { requireServicePermission } from "../lib/permissions";
import {
	applicationGroup,
	buildPartition,
	enqueueApplicationJob,
	requireApplication,
} from "./lib";
import { normalizePatchPath } from "./patches";

const request = async (
	ctx: MutationCtx,
	applicationId: Id<"applications">,
	op: "tree" | "read",
	path?: string,
) => {
	const { app, userId } = await requireApplication(
		ctx,
		applicationId,
		"service",
		"read",
	);
	if (app.source?.type !== "git") {
		throw new ConvexError("Patches need a git source");
	}
	return await enqueueApplicationJob(ctx, {
		organizationId: app.organizationId,
		partition: buildPartition(app),
		group: applicationGroup(applicationId),
		spec: { kind: "application.patchRepo", applicationId, op, path },
		requestedBy: userId,
	});
};

// Clones (or refreshes) the repository and lists its tracked files.
export const requestTree = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) =>
		await request(ctx, applicationId, "tree"),
});

export const requestFile = mutation({
	args: { applicationId: v.id("applications"), path: v.string() },
	handler: async (ctx, { applicationId, path }) =>
		await request(ctx, applicationId, "read", normalizePatchPath(path)),
});

// The parsed result once the job finished: a file tree for "tree", the file
// content for "read".
export const result = query({
	args: { jobId: v.id("jobs") },
	handler: async (ctx, { jobId }) => {
		const job = await ctx.db.get("jobs", jobId);
		if (job?.spec.kind !== "application.patchRepo") return null;
		await requireServicePermission(
			ctx,
			{ _id: job.spec.applicationId, organizationId: job.organizationId },
			"service",
			"read",
		);
		const op = await ctx.db
			.query("applicationOps")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		return {
			status: job.status,
			error: op?.error ?? job.error ?? null,
			result: op?.result ? (JSON.parse(op.result) as unknown) : null,
		};
	},
});

const OPS_TTL_MS = 24 * 60 * 60 * 1000;

export const collectOps = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - OPS_TTL_MS;
		const old = await ctx.db
			.query("applicationOps")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(100);
		for (const op of old) await ctx.db.delete("applicationOps", op._id);
	},
});
