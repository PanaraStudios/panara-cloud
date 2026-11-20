// Transfers a database to another server: stop the service, copy its volumes and
// bind mounts to the target server, switch servers and deploy there.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { validateTransferTarget } from "../infra/transfer";
import { enqueueJob } from "../lib/jobs";
import { hasPermission } from "../lib/permissions";
import { recordServiceEvent } from "../lib/serviceEvents";
import { assertPortsFree } from "./databases";
import { groupFor, loadDatabase, partitionOf } from "./lib";

export const start = mutation({
	args: {
		databaseId: v.id("databases"),
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ databaseId, targetServerId, removeSourceData },
	): Promise<Id<"jobs">> => {
		const { database, userId, access } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		if (!hasPermission(access, "deployment", "create")) {
			throw new ConvexError("Requires the deployment.create permission");
		}
		const { targetName, sourceName } = await validateTransferTarget(ctx, {
			organizationId: database.organizationId,
			currentServerId: database.serverId,
			targetServerId,
		});
		const ports = [
			database.externalPort,
			database.externalGRPCPort,
			database.externalAdminPort,
		].filter((port): port is number => port !== undefined);
		await assertPortsFree(ctx, database, ports, targetServerId).catch(
			(error: unknown) => {
				throw new ConvexError(
					`${error instanceof ConvexError ? String(error.data) : "An external port is taken"} on ${targetName}; change the external port first`,
				);
			},
		);
		const jobId = await enqueueJob(ctx, {
			organizationId: database.organizationId,
			partition: partitionOf(database.serverId),
			group: groupFor(database.engine, database._id),
			spec: {
				kind: "databases.transfer",
				databaseId,
				targetServerId,
				removeSourceData: removeSourceData ?? false,
			},
			idempotent: false,
			requestedBy: userId,
		});
		await ctx.db.insert("deployments", {
			organizationId: database.organizationId,
			jobId,
			target: { kind: "database", id: databaseId },
			title: `Transfer to ${targetName}`,
			description: `From ${sourceName}`,
		});
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"lifecycle.transfer",
			userId,
			{ from: sourceName, to: targetName },
		);
		return jobId;
	},
});
