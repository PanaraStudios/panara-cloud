import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireHostAccess } from "./access";
import { enqueueHostJob, traefikGroup } from "./hostJobs";

// GPU setup: makes NVIDIA the default Docker runtime and publishes
// the GPUs as Swarm resources. It restarts Docker, so it shares the host's
// setup group and never overlaps a server setup or Traefik change. The
// status probe is the "gpu" snapshot (infra.snapshots.get / refresh).
export const setup = mutation({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		if (scope.server && !scope.server.sshKeyId) {
			throw new ConvexError("Attach an SSH key before setting up GPU support");
		}
		if (scope.server?.serverType === "build") {
			throw new ConvexError("GPU support is for deploy servers");
		}
		const jobId = await enqueueHostJob(
			ctx,
			scope,
			traefikGroup(scope.partition),
			{ kind: "infra.gpuSetup", serverId },
		);
		await ctx.db.insert("deployments", {
			organizationId: scope.organizationId,
			jobId,
			target: { kind: "server", id: scope.partition },
			title: "GPU Setup",
			description: "Configure the NVIDIA container runtime",
		});
		return jobId;
	},
});
