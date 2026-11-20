// Reads and writes an application's Traefik config: its
// own file under the host's Traefik dynamic directory, through infra's
// file job. Results come back through infra.snapshots.opResult({ jobId }).
// Domain changes are not merged into this file: infra's routingSync rewrites it from the domains, redirects and basic auth on the
// next routing change (or transfer), so manual edits last until then.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, mutation } from "../_generated/server";
import { partitionOf, requireHostAccess } from "../infra/access";
import { enqueueOp, traefikGroup } from "../infra/hostJobs";
import { actorOf, recordServiceEvent } from "../lib/serviceEvents";
import { requireApplication } from "./lib";

const MAX_CONFIG = 512 * 1024;

// Reading the application's own file takes the traefikFiles permission on
// it. Writing to the panel host's Traefik, which the instance shares,
// stays with instance administrators.
const scopeOf = async (
	ctx: MutationCtx,
	applicationId: Id<"applications">,
	action: "read" | "write",
) => {
	const { app, userId } = await requireApplication(
		ctx,
		applicationId,
		"traefikFiles",
		action,
	);
	const scope =
		action === "write"
			? await requireHostAccess(ctx, app.serverId, "admin")
			: {
					userId,
					organizationId: app.organizationId,
					partition: partitionOf(app.serverId),
				};
	return { app, scope, path: `dynamic/${app.appName}.yml` };
};

export const read = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { app, scope, path } = await scopeOf(ctx, applicationId, "read");
		return await enqueueOp(
			ctx,
			scope,
			`traefik-files:${scope.partition}`,
			{ kind: "infra.traefikFiles", serverId: app.serverId, op: "read", path },
			{ restricted: true, idempotent: true },
		);
	},
});

export const write = mutation({
	args: { applicationId: v.id("applications"), content: v.string() },
	handler: async (ctx, { applicationId, content }) => {
		if (content.length > MAX_CONFIG) {
			throw new ConvexError("File is too large");
		}
		const { app, scope, path } = await scopeOf(ctx, applicationId, "write");
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"config.traefik",
			await actorOf(ctx),
		);
		return await enqueueOp(
			ctx,
			scope,
			traefikGroup(scope.partition),
			{
				kind: "infra.traefikFiles",
				serverId: app.serverId,
				op: "write",
				path,
			},
			{ restricted: true, input: content, idempotent: true },
		);
	},
});
