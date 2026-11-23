// Shared checks for moving a service (application, compose, database) to
// another server. The owning domains enqueue their own transfer jobs.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireInstanceAdmin } from "./access";
import {
	assertHostsFree,
	listOwnerDomains,
	type RoutingOwner,
} from "./routing";

export const PANEL_HOST_NAME = "the panel host";

export const hostName = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
): Promise<string> => {
	if (!serverId) return PANEL_HOST_NAME;
	return (await ctx.db.get("servers", serverId))?.name ?? "a deleted server";
};

// The target must be a deploy server of the organization (or
// the panel host, for instance administrators) other than the current one.
export const validateTransferTarget = async (
	ctx: QueryCtx,
	input: {
		organizationId: string;
		currentServerId: Id<"servers"> | undefined;
		targetServerId: Id<"servers"> | undefined;
		routingOwner?: RoutingOwner;
	},
): Promise<{ targetName: string; sourceName: string }> => {
	if (input.currentServerId === input.targetServerId) {
		throw new ConvexError("The service is already on the selected server");
	}
	let server: Doc<"servers"> | null = null;
	if (input.targetServerId) {
		server = await ctx.db.get("servers", input.targetServerId);
		if (!server || server.organizationId !== input.organizationId) {
			throw new ConvexError("Target server not found");
		}
		if (server.serverType !== "deploy") {
			throw new ConvexError(
				"The target server is not available for deployments",
			);
		}
		if (!server.sshKeyId) {
			throw new ConvexError("The target server has no SSH key");
		}
	} else {
		const { organizationId } = await requireInstanceAdmin(ctx);
		if (organizationId !== input.organizationId) {
			throw new ConvexError("Select a server to transfer to");
		}
	}
	if (input.currentServerId) {
		const current = await ctx.db.get("servers", input.currentServerId);
		if (current && !current.sshKeyId) {
			throw new ConvexError("The current server has no SSH key");
		}
	}
	if (input.routingOwner) {
		await assertHostsFree(
			ctx,
			input.targetServerId,
			await listOwnerDomains(ctx, input.routingOwner),
		);
	}
	return {
		targetName: server?.name ?? PANEL_HOST_NAME,
		sourceName: await hostName(ctx, input.currentServerId),
	};
};

// Networks are per host: those on the target server are kept, the rest are
// dropped (by name, for the transfer log).
export const splitNetworks = async (
	ctx: QueryCtx,
	networkIds: Id<"networks">[] | undefined,
	targetServerId: Id<"servers"> | undefined,
): Promise<{ kept: Id<"networks">[]; dropped: string[] }> => {
	const kept: Id<"networks">[] = [];
	const dropped: string[] = [];
	for (const networkId of networkIds ?? []) {
		const network = await ctx.db.get("networks", networkId);
		if (!network) continue;
		if (network.serverId === targetServerId) kept.push(networkId);
		else dropped.push(network.name);
	}
	return { kept, dropped };
};

// Jobs queued for the service before the switch would still target the old
// server; the transfer queues a fresh deploy, so they are dropped.
export const cancelQueuedServiceJobs = async (
	ctx: MutationCtx,
	group: string,
	exceptJobId: Id<"jobs">,
	kindPrefix: string,
) => {
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.take(100);
	for (const job of queued) {
		if (job._id === exceptJobId || !job.spec.kind.startsWith(kindPrefix)) {
			continue;
		}
		await ctx.db.patch("jobs", job._id, {
			status: "cancelled",
			cancelRequested: true,
			finishedAt: Date.now(),
		});
	}
};
