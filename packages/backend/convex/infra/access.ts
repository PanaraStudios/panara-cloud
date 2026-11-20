import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type Role, requireMember, requireUserId } from "../lib/access";
import { LOCAL_PARTITION } from "../tables/core";

// The panel host and instance-wide settings belong to no single organization.
// They are managed by the owner or admins of the instance's
// root organization: the instance administrator's oldest membership, or the
// oldest membership overall before an instance administrator exists.
export const getRootOrganizationId = async (
	ctx: QueryCtx,
): Promise<string | null> => {
	const adminUserId = await ctx.runQuery(
		components.betterAuth.policy.instanceAdminUserId,
		{},
	);
	if (adminUserId) {
		const membership = await ctx.db
			.query("memberships")
			.withIndex("by_userId", (q) => q.eq("userId", adminUserId))
			.order("asc")
			.first();
		if (membership) return membership.organizationId;
	}
	const first = await ctx.db.query("memberships").order("asc").first();
	return first?.organizationId ?? null;
};

export const requireInstanceAdmin = async (
	ctx: QueryCtx,
): Promise<{ userId: string; organizationId: string }> => {
	await requireUserId(ctx);
	const organizationId = await getRootOrganizationId(ctx);
	if (!organizationId) throw new ConvexError("Instance is not initialized");
	const { userId } = await requireMember(ctx, organizationId, "admin").catch(
		() => {
			throw new ConvexError("Requires an instance administrator");
		},
	);
	return { userId, organizationId };
};

// Rows an organization keeps on a host (certificates, networks, sandboxes,
// the Vector agent): on the panel host (no serverId) only the instance
// administrator, acting for the root organization, may manage them.
export const assertPanelHostAllowed = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	if (serverId) return;
	const { organizationId: root } = await requireInstanceAdmin(ctx);
	if (root !== organizationId) {
		throw new ConvexError(
			"Only the instance administrator can manage the Panara Cloud server",
		);
	}
};

export type HostScope = {
	userId: string;
	organizationId: string;
	serverId: Id<"servers"> | undefined;
	partition: string;
	server: Doc<"servers"> | null;
};

// Authorizes an operation on a host: a server of the caller's organization,
// or the panel host (no serverId) for instance administrators.
export const requireHostAccess = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
	role: Role,
): Promise<HostScope> => {
	if (!serverId) {
		const { userId, organizationId } = await requireInstanceAdmin(ctx);
		return {
			userId,
			organizationId,
			serverId: undefined,
			partition: LOCAL_PARTITION,
			server: null,
		};
	}
	const server = await ctx.db.get("servers", serverId);
	if (!server) throw new ConvexError("Server not found");
	const { userId } = await requireMember(ctx, server.organizationId, role);
	return {
		userId,
		organizationId: server.organizationId,
		serverId,
		partition: serverId,
		server,
	};
};

export const partitionOf = (serverId: Id<"servers"> | undefined): string =>
	serverId ?? LOCAL_PARTITION;
