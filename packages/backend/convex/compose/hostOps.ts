// One-off host reads for a compose service whose result lands in
// `composeOps` (read it with compose.deploy.getOp): the volumes of a running
// service, and browsing the repository to create patches (the patches
// themselves are managed through applications.patches with owner kind
// "compose" and applied by every compose deploy).
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation } from "../_generated/server";
import { normalizePatchPath } from "../applications/patches";
import type { JobSpec } from "../lib/jobs";
import { enqueueComposeJob, loadCompose } from "./lib";

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const startOp = async (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	kind: "mounts" | "patchRepo",
	spec: (opId: Id<"composeOps">) => JobSpec,
	requestedBy: string,
): Promise<{ opId: Id<"composeOps">; jobId: Id<"jobs"> }> => {
	const opId = await ctx.db.insert("composeOps", {
		organizationId: compose.organizationId,
		composeId: compose._id,
		kind,
	});
	const jobId = await enqueueComposeJob(ctx, compose, spec(opId), {
		requestedBy,
		idempotent: true,
		maxAttempts: 2,
	});
	await ctx.db.patch("composeOps", opId, { jobId });
	return { opId, jobId };
};

// The named volumes the service's running
// container uses, as Docker reports them (JSON array of mounts).
export const loadMounts = mutation({
	args: { composeId: v.id("compose"), serviceName: v.string() },
	handler: async (ctx, { composeId, serviceName }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		const name = serviceName.trim();
		if (!SERVICE_NAME.test(name)) throw new ConvexError("Invalid service name");
		return await startOp(
			ctx,
			compose,
			"mounts",
			(opId) => ({
				kind: "compose.loadMounts",
				composeId,
				opId,
				serviceName: name,
			}),
			userId,
		);
	},
});

const requestPatchRepo = async (
	ctx: MutationCtx,
	composeId: Id<"compose">,
	op: "tree" | "read",
	path?: string,
) => {
	const { compose, userId } = await loadCompose(
		ctx,
		composeId,
		"service",
		"read",
	);
	if (compose.sourceType !== "git" || !compose.gitSource) {
		throw new ConvexError("Patches need a git source");
	}
	return await startOp(
		ctx,
		compose,
		"patchRepo",
		(opId) => ({ kind: "compose.patchRepo", composeId, opId, op, path }),
		userId,
	);
};

// Clones (or refreshes) the repository and lists its tracked files.
export const requestPatchTree = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) =>
		await requestPatchRepo(ctx, composeId, "tree"),
});

export const requestPatchFile = mutation({
	args: { composeId: v.id("compose"), path: v.string() },
	handler: async (ctx, { composeId, path }) =>
		await requestPatchRepo(ctx, composeId, "read", normalizePatchPath(path)),
});
