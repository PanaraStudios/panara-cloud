// Transfers an application to another server: stop on the source server, copy its
// volumes and bind mounts to the target, switch servers (which re-homes its
// routing), clean up the source and deploy on the target.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { validateTransferTarget } from "../infra/transfer";
import { hasPermission } from "../lib/permissions";
import { recordServiceEvent } from "../lib/serviceEvents";
import {
	applicationGroup,
	applicationOwner,
	deployPartition,
	enqueueApplicationJob,
	requireApplication,
} from "./lib";

export const start = mutation({
	args: {
		applicationId: v.id("applications"),
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ applicationId, targetServerId, removeSourceData },
	): Promise<Id<"jobs">> => {
		const { app, userId, access } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		if (!hasPermission(access, "deployment", "create")) {
			throw new ConvexError("Requires the deployment.create permission");
		}
		const { targetName, sourceName } = await validateTransferTarget(ctx, {
			organizationId: app.organizationId,
			currentServerId: app.serverId,
			targetServerId,
			routingOwner: applicationOwner(applicationId),
		});
		const jobId = await enqueueApplicationJob(ctx, {
			organizationId: app.organizationId,
			partition: deployPartition(app),
			group: applicationGroup(applicationId),
			spec: {
				kind: "application.transfer",
				applicationId,
				targetServerId,
				removeSourceData: removeSourceData ?? false,
			},
			requestedBy: userId,
		});
		await ctx.db.insert("deployments", {
			organizationId: app.organizationId,
			jobId,
			target: applicationOwner(applicationId),
			title: `Transfer to ${targetName}`,
			description: `From ${sourceName}`,
		});
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"lifecycle.transfer",
			userId,
			{ from: sourceName, to: targetName },
		);
		return jobId;
	},
});
