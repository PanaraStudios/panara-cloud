import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { sha256Hex } from "./lib/crypto";

const randomToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

// Run by an operator: `npx convex run agents:enroll '{"name":"panel"}'`.
// The returned secret is shown once; only its hash is stored.
export const enroll = internalAction({
	args: { name: v.string() },
	handler: async (
		ctx,
		{ name },
	): Promise<{ agentId: string; secret: string }> => {
		const agentId: string = await ctx.runMutation(internal.agents.insert, {
			name,
		});
		const secret = `pca_${agentId}_${randomToken()}`;
		await ctx.runMutation(internal.agents.setSecretHash, {
			agentId,
			secretHash: await sha256Hex(secret),
		});
		return { agentId, secret };
	},
});

export const insert = internalMutation({
	args: { name: v.string() },
	handler: async (ctx, { name }) => {
		return await ctx.db.insert("agents", {
			name,
			secretHash: "",
			disabled: true,
		});
	},
});

export const setSecretHash = internalMutation({
	args: { agentId: v.string(), secretHash: v.string() },
	handler: async (ctx, { agentId, secretHash }) => {
		const id = ctx.db.normalizeId("agents", agentId);
		if (!id) throw new ConvexError("Unknown agent");
		await ctx.db.patch("agents", id, { secretHash, disabled: false });
	},
});

export const disable = internalMutation({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		await ctx.db.patch("agents", agentId, { disabled: true });
	},
});

export const verifySecret = internalQuery({
	args: { agentId: v.string(), secretHash: v.string() },
	handler: async (ctx, { agentId, secretHash }) => {
		const id = ctx.db.normalizeId("agents", agentId);
		const agent = id ? await ctx.db.get("agents", id) : null;
		return Boolean(
			agent &&
				!agent.disabled &&
				agent.secretHash &&
				agent.secretHash === secretHash,
		);
	},
});
