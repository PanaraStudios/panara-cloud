// Transfers a compose service to another server: stop the project, copy its
// volumes, bind mounts and directory to the target server, switch servers
// and deploy there.
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { validateTransferTarget } from "../infra/transfer";
import { requireServicePermission } from "../lib/permissions";
import { recordServiceEvent } from "../lib/serviceEvents";
import { enqueueComposeJob, loadCompose, owner } from "./lib";

export const start = mutation({
	args: {
		composeId: v.id("compose"),
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ composeId, targetServerId, removeSourceData },
	): Promise<Id<"jobs">> => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		await requireServicePermission(ctx, compose, "deployment", "create");
		const { targetName, sourceName } = await validateTransferTarget(ctx, {
			organizationId: compose.organizationId,
			currentServerId: compose.serverId,
			targetServerId,
			routingOwner: owner(composeId),
		});
		const jobId = await enqueueComposeJob(
			ctx,
			compose,
			{
				kind: "compose.transfer",
				composeId,
				targetServerId,
				removeSourceData: removeSourceData ?? false,
			},
			{ requestedBy: userId },
		);
		await ctx.db.insert("deployments", {
			organizationId: compose.organizationId,
			jobId,
			target: owner(composeId),
			title: `Transfer to ${targetName}`,
			description: `From ${sourceName}`,
		});
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			"lifecycle.transfer",
			userId,
			{ from: sourceName, to: targetName },
		);
		return jobId;
	},
});
