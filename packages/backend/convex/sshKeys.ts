import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { requireMember } from "./lib/access";
import { encryptSecret } from "./lib/crypto";
import { requirePermission } from "./lib/permissions";

const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 16 * 1024;

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "sshKeys", "read");
		return await ctx.db
			.query("sshKeys")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_KEYS);
	},
});

// Names for picking a key in a service's git
// source, open to every member.
export const listForApps = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		const keys = await ctx.db
			.query("sshKeys")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_KEYS);
		return keys.map((key) => ({ _id: key._id, name: key.name }));
	},
});

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		publicKey: v.string(),
		privateKey: v.string(),
	},
	handler: async (ctx, args): Promise<Id<"sshKeys">> => {
		const name = args.name.trim();
		const publicKey = args.publicKey.trim();
		const privateKey = args.privateKey.trim();
		if (!name) throw new ConvexError("Name is required");
		if (!publicKey.startsWith("ssh-") && !publicKey.startsWith("ecdsa-")) {
			throw new ConvexError("Public key must be in OpenSSH format");
		}
		if (!privateKey.includes("PRIVATE KEY-----")) {
			throw new ConvexError("Private key must be PEM or OpenSSH encoded");
		}
		if (privateKey.length > MAX_KEY_LENGTH) {
			throw new ConvexError("Private key is too large");
		}
		const encrypted = await encryptSecret(`${privateKey}\n`);
		return await ctx.runMutation(internal.sshKeys.insert, {
			organizationId: args.organizationId,
			name,
			description: args.description,
			publicKey,
			...encrypted,
		});
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		publicKey: v.string(),
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, { iv, ciphertext, ...key }) => {
		await requirePermission(ctx, key.organizationId, "sshKeys", "create");
		const sshKeyId = await ctx.db.insert("sshKeys", key);
		await ctx.db.insert("secrets", {
			organizationId: key.organizationId,
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			iv,
			ciphertext,
		});
		return sshKeyId;
	},
});

export const update = mutation({
	args: {
		sshKeyId: v.id("sshKeys"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { sshKeyId, name, description }) => {
		const key = await ctx.db.get("sshKeys", sshKeyId);
		if (!key) throw new ConvexError("SSH key not found");
		await requirePermission(ctx, key.organizationId, "sshKeys", "create");
		const trimmed = name?.trim();
		if (name !== undefined && !trimmed) {
			throw new ConvexError("Name is required");
		}
		await ctx.db.patch("sshKeys", sshKeyId, {
			...(trimmed ? { name: trimmed } : {}),
			...(description !== undefined ? { description } : {}),
		});
	},
});

export const remove = mutation({
	args: { sshKeyId: v.id("sshKeys") },
	handler: async (ctx, { sshKeyId }) => {
		const key = await ctx.db.get("sshKeys", sshKeyId);
		if (!key) return;
		await requirePermission(ctx, key.organizationId, "sshKeys", "delete");
		const inUse = await ctx.db
			.query("servers")
			.withIndex("by_sshKeyId", (q) => q.eq("sshKeyId", sshKeyId))
			.first();
		if (inUse) {
			throw new ConvexError(
				`SSH key is used by server "${inUse.name}"; detach it first`,
			);
		}
		const secret = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", "sshPrivateKey").eq("ownerId", sshKeyId),
			)
			.unique();
		if (secret) await ctx.db.delete("secrets", secret._id);
		await ctx.db.delete("sshKeys", sshKeyId);
	},
});
