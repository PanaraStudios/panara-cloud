import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export const agentIssuer = (): string => `${process.env.CONVEX_SITE_URL}/agent`;

export const requireUserId = async (ctx: QueryCtx): Promise<string> => {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity || identity.issuer === agentIssuer()) {
		throw new ConvexError("Not authenticated");
	}
	return identity.subject;
};

export const requireMember = async (
	ctx: QueryCtx,
	organizationId: string,
	minRole: Role = "member",
): Promise<{ userId: string; role: Role }> => {
	const userId = await requireUserId(ctx);
	const membership = await ctx.db
		.query("memberships")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.unique();
	if (!membership) {
		throw new ConvexError("Not a member of this organization");
	}
	if (membership.deactivated) {
		throw new ConvexError("This account has been deactivated");
	}
	if (RANK[membership.role] < RANK[minRole]) {
		throw new ConvexError(`Requires the ${minRole} role`);
	}
	return { userId, role: membership.role };
};

export const toRole = (role: string): Role =>
	role === "owner" || role === "admin" ? role : "member";
