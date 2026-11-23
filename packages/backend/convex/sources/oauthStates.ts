import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { sha256Hex } from "../lib/crypto";
import { oauthPurpose } from "../tables/sources";

const STATE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_BATCH = 200;

const randomToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

export const createOAuthState = async (
	ctx: MutationCtx,
	state: {
		organizationId: string;
		userId: string;
		purpose: typeof oauthPurpose.type;
		gitProviderId?: Id<"gitProviders">;
		githubUrl?: string;
	},
): Promise<string> => {
	const token = randomToken();
	await ctx.db.insert("oauthStates", {
		...state,
		stateHash: await sha256Hex(token),
		expiresAt: Date.now() + STATE_TTL_MS,
	});
	return token;
};

// Single use: the row is deleted whether or not it is still valid.
export const consume = internalMutation({
	args: { state: v.string(), purposes: v.array(oauthPurpose) },
	handler: async (ctx, { state, purposes }) => {
		const stateHash = await sha256Hex(state);
		const row = await ctx.db
			.query("oauthStates")
			.withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
			.unique();
		if (!row) return null;
		await ctx.db.delete("oauthStates", row._id);
		if (row.expiresAt < Date.now() || !purposes.includes(row.purpose)) {
			return null;
		}
		return {
			organizationId: row.organizationId,
			userId: row.userId,
			purpose: row.purpose,
			gitProviderId: row.gitProviderId,
			githubUrl: row.githubUrl,
		};
	},
});

export const cleanupExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("oauthStates")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
			.take(CLEANUP_BATCH);
		for (const row of expired) await ctx.db.delete("oauthStates", row._id);
	},
});
