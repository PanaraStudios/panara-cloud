import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { type Role, requireMember } from "../lib/access";
import { requirePermission } from "../lib/permissions";
import { memberRole } from "../tables/core";

export const canUseProvider = (
	provider: Doc<"gitProviders">,
	userId: string,
	role: Role,
): boolean =>
	role !== "member" ||
	provider.userId === userId ||
	provider.sharedWithOrganization;

// Using a provider (listing repositories, picking it as a source) is open to
// admins, its creator, and everyone when it is shared with the organization.
export const loadProviderForUse = async (
	ctx: QueryCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	const provider = await ctx.db.get("gitProviders", gitProviderId);
	if (!provider) throw new ConvexError("Git provider not found");
	const { userId, role } = await requireMember(ctx, provider.organizationId);
	if (!canUseProvider(provider, userId, role)) {
		throw new ConvexError("You don't have access to this git provider");
	}
	return { provider, userId, role };
};

// Changing a provider or (re)authorizing it needs gitProviders.create
// (members get it with the "Access to Git Providers" grant); members only
// manage the providers they created.
export const loadProviderForManage = async (
	ctx: QueryCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	const provider = await ctx.db.get("gitProviders", gitProviderId);
	if (!provider) throw new ConvexError("Git provider not found");
	const { userId, role } = await requirePermission(
		ctx,
		provider.organizationId,
		"gitProviders",
		"create",
	);
	if (role === "member" && provider.userId !== userId) {
		throw new ConvexError("You can only manage your own Git providers");
	}
	return { provider, userId, role };
};

// For actions, which can't read memberships themselves.
export const member = internalQuery({
	args: { organizationId: v.string(), role: memberRole },
	handler: async (ctx, { organizationId, role }) =>
		await requireMember(ctx, organizationId, role),
});
