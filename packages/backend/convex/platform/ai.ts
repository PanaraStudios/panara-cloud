import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requirePermission } from "../lib/permissions";
import { AI_SECRET_KIND, AI_SECRET_MASK } from "./lib/aiSettings";
import { panelServerIp } from "./lib/panel";
import { deleteSecret, readSecretFields, writeSecret } from "./lib/secrets";

const MAX_SETTINGS = 100;
const MAX_CUSTOM_PROVIDERS = 50;

const aiAction = v.union(
	v.literal("read"),
	v.literal("create"),
	v.literal("update"),
	v.literal("delete"),
);
type AiAction = "read" | "create" | "update" | "delete";
const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const findOrgSettings = (ctx: QueryCtx, organizationId: string) =>
	ctx.db
		.query("organizationSettings")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.unique();

const loadSetting = async (
	ctx: QueryCtx,
	aiId: Id<"aiSettings">,
	action: AiAction,
) => {
	const setting = await ctx.db.get("aiSettings", aiId);
	if (!setting) throw new ConvexError("AI settings not found");
	const { userId } = await requirePermission(
		ctx,
		setting.organizationId,
		"ai",
		action,
	);
	return { setting, userId };
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "ai", "read");
		return await ctx.db
			.query("aiSettings")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_SETTINGS);
	},
});

export const get = query({
	args: { aiId: v.id("aiSettings") },
	handler: async (ctx, { aiId }) => {
		const setting = await ctx.db.get("aiSettings", aiId);
		if (!setting) return null;
		await requirePermission(ctx, setting.organizationId, "ai", "read");
		return { ...setting, apiKey: AI_SECRET_MASK };
	},
});

export const getEnabledProviders = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "ai", "read");
		const settings = await ctx.db
			.query("aiSettings")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_SETTINGS);
		return settings
			.filter((s) => s.isEnabled)
			.map((s) => ({ aiId: s._id, name: s.name, model: s.model }));
	},
});

export const remove = mutation({
	args: { aiId: v.id("aiSettings") },
	handler: async (ctx, { aiId }) => {
		const setting = await ctx.db.get("aiSettings", aiId);
		if (!setting) return;
		await requirePermission(ctx, setting.organizationId, "ai", "delete");
		await deleteSecret(ctx, AI_SECRET_KIND, aiId);
		await ctx.db.delete("aiSettings", aiId);
	},
});

export const getCustomProviders = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "ai", "read");
		return (
			(await findOrgSettings(ctx, organizationId))?.customAiProviders ?? []
		);
	},
});

export const saveCustomProviders = mutation({
	args: {
		organizationId: v.string(),
		providers: v.array(v.object({ name: v.string(), apiUrl: v.string() })),
	},
	handler: async (ctx, { organizationId, providers }) => {
		await requirePermission(ctx, organizationId, "ai", "update");
		if (providers.length > MAX_CUSTOM_PROVIDERS) {
			throw new ConvexError("Too many custom providers");
		}
		const cleaned = providers.map((provider) => {
			const name = provider.name.trim();
			const apiUrl = provider.apiUrl.trim();
			if (!name) throw new ConvexError("Name is required");
			try {
				new URL(apiUrl);
			} catch {
				throw new ConvexError("Please enter a valid URL");
			}
			return { name, apiUrl };
		});
		const existing = await findOrgSettings(ctx, organizationId);
		if (existing) {
			await ctx.db.patch("organizationSettings", existing._id, {
				customAiProviders: cleaned,
			});
		} else {
			await ctx.db.insert("organizationSettings", {
				organizationId,
				customAiProviders: cleaned,
			});
		}
		return cleaned;
	},
});

export const assertRole = internalQuery({
	args: { organizationId: v.string(), action: aiAction },
	handler: async (ctx, { organizationId, action }) => {
		await requirePermission(ctx, organizationId, "ai", action);
		return {
			customProviders:
				(await findOrgSettings(ctx, organizationId))?.customAiProviders ?? [],
		};
	},
});

// Decrypts the stored key for an action; never exposed to clients.
export const loadForAction = internalQuery({
	args: {
		aiId: v.id("aiSettings"),
		action: aiAction,
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { aiId, action, serverId }) => {
		const { setting } = await loadSetting(ctx, aiId, action);
		const secret = await readSecretFields(ctx, AI_SECRET_KIND, aiId);
		const orgSettings = await findOrgSettings(ctx, setting.organizationId);
		let serverIp = await panelServerIp(ctx);
		if (serverId) {
			const server = await ctx.db.get("servers", serverId);
			if (!server || server.organizationId !== setting.organizationId) {
				throw new ConvexError("Server not found");
			}
			serverIp = server.ipAddress;
		}
		return {
			setting,
			apiKey: secret?.apiKey ?? "",
			serverIp,
			customProviders: orgSettings?.customAiProviders ?? [],
		};
	},
});

const settingFields = {
	name: v.string(),
	apiUrl: v.string(),
	model: v.string(),
	isEnabled: v.boolean(),
};

export const insert = internalMutation({
	args: { organizationId: v.string(), ...settingFields, secret: encrypted },
	handler: async (ctx, { secret, ...fields }) => {
		await requirePermission(ctx, fields.organizationId, "ai", "create");
		const aiId = await ctx.db.insert("aiSettings", fields);
		await writeSecret(ctx, {
			organizationId: fields.organizationId,
			kind: AI_SECRET_KIND,
			ownerId: aiId,
			secret,
		});
		return aiId;
	},
});

export const replace = internalMutation({
	args: {
		aiId: v.id("aiSettings"),
		...settingFields,
		secret: v.optional(encrypted),
	},
	handler: async (ctx, { aiId, secret, ...fields }) => {
		const { setting } = await loadSetting(ctx, aiId, "update");
		await ctx.db.replace("aiSettings", aiId, {
			organizationId: setting.organizationId,
			...fields,
		});
		if (secret) {
			await writeSecret(ctx, {
				organizationId: setting.organizationId,
				kind: AI_SECRET_KIND,
				ownerId: aiId,
				secret,
			});
		}
	},
});
