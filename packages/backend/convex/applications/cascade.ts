import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { deleteSecret } from "../lib/secrets";
import { applicationOwner, ROLLBACK_CONTEXT_KIND } from "./lib";
import { removePatchesForOwner } from "./patches";
import { removePreview } from "./previews";

const BATCH = 25;

// Runs after an application row is deleted and reschedules itself until
// every dependent row is gone.
export const removeApplicationData = internalMutation({
	args: {
		applicationId: v.id("applications"),
		deployPartition: v.string(),
		buildPartition: v.string(),
	},
	handler: async (ctx, args) => {
		let deleted = 0;
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_applicationId", (q) =>
				q.eq("applicationId", args.applicationId),
			)
			.take(BATCH);
		for (const preview of previews) {
			await removePreview(ctx, preview, {
				deploy: args.deployPartition,
				build: args.buildPartition,
			});
			deleted++;
		}
		deleted += await removePatchesForOwner(
			ctx,
			applicationOwner(args.applicationId),
			BATCH,
		);
		const rollbacks = await ctx.db
			.query("applicationRollbacks")
			.withIndex("by_applicationId_and_version", (q) =>
				q.eq("applicationId", args.applicationId),
			)
			.take(BATCH);
		for (const rollback of rollbacks) {
			await ctx.db.delete("applicationRollbacks", rollback._id);
			await deleteSecret(ctx, ROLLBACK_CONTEXT_KIND, rollback._id);
			deleted++;
		}
		const deployments = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "application").eq("target.id", args.applicationId),
			)
			.take(BATCH * 4);
		for (const deployment of deployments) {
			await ctx.db.delete("deployments", deployment._id);
			deleted++;
		}
		if (deleted > 0) {
			await ctx.scheduler.runAfter(
				0,
				internal.applications.cascade.removeApplicationData,
				args,
			);
		}
	},
});
