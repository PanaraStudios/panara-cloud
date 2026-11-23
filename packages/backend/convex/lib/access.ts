import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export const agentIssuer = (): string => `${process.env.CONVEX_SITE_URL}/agent`;

// Tokens the API gateway mints for one call made with an API key
// (platform/apiGateway.ts). They never leave the backend.
export const apiKeyIssuer = (): string =>
	`${process.env.CONVEX_SITE_URL}/api-key`;

export const API_KEY_WRONG_ORGANIZATION =
	"This API key belongs to another organization";
export const API_KEY_NOT_ALLOWED = "Not available with an API key";
export const PEOPLE_AND_ACCESS_BY_KEY =
	"People and access are managed by a signed-in user in the panel";

export type ApiKeyScope = { apiKeyId: string; organizationId: string };

// Who is calling. With `apiKey` set the call came through the API gateway
// and the user id alone grants nothing: the key acts for one organization.
export type Caller = { userId: string; apiKey: ApiKeyScope | null };

type AuthCtx = Pick<QueryCtx, "auth">;

// This file is the only place a user identity is read; everything else asks
// for a caller, a user or a member (see access.guard.test.ts).
export const optionalCaller = async (ctx: AuthCtx): Promise<Caller | null> => {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity || identity.issuer === agentIssuer()) return null;
	if (identity.issuer !== apiKeyIssuer()) {
		return { userId: identity.subject, apiKey: null };
	}
	const { organizationId, apiKeyId } = identity;
	if (
		typeof organizationId !== "string" ||
		!organizationId ||
		typeof apiKeyId !== "string" ||
		!apiKeyId
	) {
		return null;
	}
	return { userId: identity.subject, apiKey: { apiKeyId, organizationId } };
};

// Any signed-in user or API key. Enough for facts every user of the instance
// may read; for anything else use requireMember or requireUserId.
export const requireCaller = async (ctx: AuthCtx): Promise<Caller> => {
	const caller = await optionalCaller(ctx);
	if (!caller) throw new ConvexError("Not authenticated");
	return caller;
};

// The signed-in user with no organization in play: their account-wide data,
// and anything decided by who they are alone. An API key never passes, since
// it would reach past its organization.
export const requireUserId = async (ctx: AuthCtx): Promise<string> => {
	const caller = await requireCaller(ctx);
	if (caller.apiKey) throw new ConvexError(API_KEY_NOT_ALLOWED);
	return caller.userId;
};

// Creating, removing or changing people and their access. A key that could
// do it could also outlive its own revocation: an account it created, or one
// it took over with a reset link, can sign in and mint keys of its own.
export const refuseApiKeyForPeople = async (ctx: AuthCtx): Promise<Caller> => {
	const caller = await requireCaller(ctx);
	if (caller.apiKey) throw new ConvexError(PEOPLE_AND_ACCESS_BY_KEY);
	return caller;
};

export const requireMember = async (
	ctx: QueryCtx,
	organizationId: string,
	minRole: Role = "member",
): Promise<{ userId: string; role: Role }> => {
	const { userId, apiKey } = await requireCaller(ctx);
	if (apiKey && apiKey.organizationId !== organizationId) {
		throw new ConvexError(API_KEY_WRONG_ORGANIZATION);
	}
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
