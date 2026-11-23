import { ConvexError, v } from "convex/values";
import { type MutationCtx, mutation, query } from "../_generated/server";
import { type HostScope, requireHostAccess } from "./access";
import { enqueueHostJob, traefikGroup } from "./hostJobs";

const MAX_SETUP_HISTORY = 20;

// Installs Docker (if missing), Swarm, panara-cloud-network, /etc/panara-cloud and Traefik,
// plus build tooling; build servers only get build dependencies. Without a
// serverId it prepares the panel host itself (instance administrators only).
export const enqueueServerSetup = async (
	ctx: MutationCtx,
	scope: Pick<
		HostScope,
		"organizationId" | "partition" | "userId" | "serverId" | "server"
	>,
) => {
	const jobId = await enqueueHostJob(
		ctx,
		scope,
		traefikGroup(scope.partition),
		{ kind: "infra.serverSetup", serverId: scope.serverId },
		{ idempotent: true, maxAttempts: 1 },
	);
	await ctx.db.insert("deployments", {
		organizationId: scope.organizationId,
		jobId,
		target: { kind: "server", id: scope.partition },
		title: "Setup Server",
		description:
			scope.server?.serverType === "build"
				? "Install build server dependencies"
				: "Install server dependencies",
	});
	return jobId;
};

export const run = mutation({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		if (scope.server && !scope.server.sshKeyId) {
			throw new ConvexError("Attach an SSH key before setting up the server");
		}
		if (scope.server?.serverStatus === "inactive") {
			throw new ConvexError("Server is inactive");
		}
		return await enqueueServerSetup(ctx, scope);
	},
});

export const history = query({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		const deployments = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "server").eq("target.id", scope.partition),
			)
			.order("desc")
			.take(MAX_SETUP_HISTORY);
		return await Promise.all(
			deployments.map(async (deployment) => {
				const job = await ctx.db.get("jobs", deployment.jobId);
				return {
					...deployment,
					status: job?.status ?? null,
					error: job?.error ?? null,
					finishedAt: job?.finishedAt ?? null,
				};
			}),
		);
	},
});
