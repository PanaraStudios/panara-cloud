import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { enqueueJob } from "../lib/jobs";
import { deleteSecret } from "../lib/secrets";
import { rollbackCutoffs } from "../serviceEvents";
import {
	applicationGroup,
	applicationOwner,
	deployPartition,
	enqueueDeployment,
	ROLLBACK_CONTEXT_KIND,
	requireApplication,
} from "./lib";
import { enqueueRollbackImagesRemove } from "./rollbackImages";

export const list = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { app } = await requireApplication(
			ctx,
			applicationId,
			"deployment",
			"read",
		);
		return await ctx.db
			.query("applicationRollbacks")
			.withIndex("by_applicationId_and_version", (q) =>
				q.eq("applicationId", applicationId),
			)
			.order("desc")
			.take(Math.max(app.rollback.keep, 50));
	},
});

export const rollback = mutation({
	args: { rollbackId: v.id("applicationRollbacks") },
	handler: async (ctx, { rollbackId }) => {
		const row = await ctx.db.get("applicationRollbacks", rollbackId);
		if (!row) throw new ConvexError("Rollback not found");
		const { app, userId } = await requireApplication(
			ctx,
			row.applicationId,
			"deployment",
			"create",
		);
		return await enqueueDeployment(ctx, {
			organizationId: app.organizationId,
			partition: deployPartition(app),
			group: applicationGroup(app._id),
			spec: {
				kind: "application.rollback",
				applicationId: app._id,
				rollbackId,
				appliedAt: (await rollbackCutoffs(ctx, row)) ?? undefined,
			},
			target: applicationOwner(app._id),
			title: `Rollback to v${row.version}`,
			description: row.image,
			requestedBy: userId,
		});
	},
});

export const remove = mutation({
	args: { rollbackId: v.id("applicationRollbacks") },
	handler: async (ctx, { rollbackId }) => {
		const row = await ctx.db.get("applicationRollbacks", rollbackId);
		if (!row) return;
		const { app, userId } = await requireApplication(
			ctx,
			row.applicationId,
			"deployment",
			"create",
		);
		await ctx.db.delete("applicationRollbacks", rollbackId);
		await deleteSecret(ctx, ROLLBACK_CONTEXT_KIND, rollbackId);
		await enqueueJob(ctx, {
			organizationId: app.organizationId,
			partition: deployPartition(app),
			group: applicationGroup(app._id),
			spec: {
				kind: "infra.dockerAction",
				serverId: app.serverId,
				action: { type: "imageRemove", imageRef: row.localTag, force: true },
			},
			idempotent: true,
			requestedBy: userId,
		});
		await enqueueRollbackImagesRemove(ctx, app, [row], userId);
	},
});
