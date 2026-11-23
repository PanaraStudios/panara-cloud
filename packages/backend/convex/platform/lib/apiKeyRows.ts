import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Role } from "../../lib/access";
import { loadGrants, permissionsForMember } from "../../lib/permissions";

// Matches MAX_KEYS_PER_USER in platform/apiKeys.ts.
const MAX_KEYS_PER_USER = 50;

export const deleteApiKey = async (
	ctx: Pick<MutationCtx, "db">,
	apiKeyId: Id<"apiKeys">,
) => {
	const counter = await ctx.db
		.query("apiRateLimits")
		.withIndex("by_key", (q) => q.eq("key", apiKeyId))
		.unique();
	if (counter) await ctx.db.delete("apiRateLimits", counter._id);
	await ctx.db.delete("apiKeys", apiKeyId);
};

// A key acts as its user inside one organization. When that membership ends,
// or the account is deactivated or deleted, its keys go with it: left in
// place, a key would come back to life with whatever role a later
// invitation gives.
export const deleteApiKeysOf = async (
	ctx: Pick<MutationCtx, "db">,
	userId: string,
	organizationId: string,
) => {
	const keys = await ctx.db
		.query("apiKeys")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.take(MAX_KEYS_PER_USER);
	for (const key of keys) await deleteApiKey(ctx, key._id);
};

// For a change of role or grants: a member left without the "Access to API"
// permission loses their keys of that organization, so granting it again
// starts with none instead of reviving the old ones.
export const deleteApiKeysWithoutAccess = async (
	ctx: Pick<MutationCtx, "db">,
	userId: string,
	organizationId: string,
	role: Role,
) => {
	const grants = await loadGrants(ctx, organizationId, userId);
	if (permissionsForMember(role, grants).api.read) return;
	await deleteApiKeysOf(ctx, userId, organizationId);
};
