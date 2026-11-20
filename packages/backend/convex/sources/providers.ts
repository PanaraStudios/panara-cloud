import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { requireMember } from "../lib/access";
import { requirePermission } from "../lib/permissions";
import { gitProviderConfig, gitProviderType } from "../tables/sources";
import {
	canUseProvider,
	loadProviderForManage,
	loadProviderForUse,
} from "./access";
import {
	deleteProviderSecrets,
	encryptedProviderSecret,
	readProviderSecrets,
	writeProviderSecrets,
} from "./secrets";
import { callbackUrls } from "./urls";

const MAX_PROVIDERS = 200;

export const toPublic = (provider: Doc<"gitProviders">, userId: string) => {
	const { config } = provider;
	return {
		_id: provider._id,
		_creationTime: provider._creationTime,
		organizationId: provider.organizationId,
		name: provider.name,
		providerType: provider.providerType,
		sharedWithOrganization: provider.sharedWithOrganization,
		isOwner: provider.userId === userId,
		connected: provider.connected,
		config,
		// Bitbucket app passwords are being retired in favour of API tokens.
		isDeprecated:
			config.type === "bitbucket" && config.authMode === "appPassword",
		redirectUri:
			config.type === "gitlab"
				? callbackUrls().gitlab
				: config.type === "gitea"
					? callbackUrls().gitea
					: undefined,
	};
};

export const list = query({
	args: {
		organizationId: v.string(),
		providerType: v.optional(gitProviderType),
		onlyConnected: v.optional(v.boolean()),
	},
	handler: async (ctx, { organizationId, providerType, onlyConnected }) => {
		const { userId, role } = await requireMember(ctx, organizationId);
		const providers = await ctx.db
			.query("gitProviders")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_PROVIDERS);
		return providers
			.filter(
				(p) =>
					canUseProvider(p, userId, role) &&
					(!providerType || p.providerType === providerType) &&
					(!onlyConnected || p.connected),
			)
			.map((p) => toPublic(p, userId));
	},
});

export const get = query({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider, userId } = await loadProviderForUse(ctx, gitProviderId);
		return toPublic(provider, userId);
	},
});

// Where GitHub, GitLab and Gitea send the browser back to; shown in the
// connect dialogs before a provider exists.
export const callbacks = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		return callbackUrls();
	},
});

// Only the creator decides whether other members may use their provider.
export const toggleShare = mutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		sharedWithOrganization: v.boolean(),
	},
	handler: async (ctx, { gitProviderId, sharedWithOrganization }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (!provider) throw new ConvexError("Git provider not found");
		const { userId } = await requireMember(ctx, provider.organizationId);
		if (provider.userId !== userId) {
			throw new ConvexError("Only the owner can share this provider");
		}
		await ctx.db.patch("gitProviders", gitProviderId, {
			sharedWithOrganization,
		});
	},
});

export const rename = mutation({
	args: { gitProviderId: v.id("gitProviders"), name: v.string() },
	handler: async (ctx, { gitProviderId, name }) => {
		await loadProviderForManage(ctx, gitProviderId);
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Name is required");
		await ctx.db.patch("gitProviders", gitProviderId, { name: trimmed });
	},
});

export const removeProvider = async (
	ctx: MutationCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	await deleteProviderSecrets(ctx, gitProviderId);
	const tokens = await ctx.db
		.query("gitProviderTokens")
		.withIndex("by_gitProviderId", (q) => q.eq("gitProviderId", gitProviderId))
		.unique();
	if (tokens) await ctx.db.delete("gitProviderTokens", tokens._id);
	await ctx.db.delete("gitProviders", gitProviderId);
};

// Admins can remove any provider; members only their own. Services that
// still reference it fail to clone with "Git provider not found".
export const remove = mutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (!provider) return;
		const { userId, role } = await requirePermission(
			ctx,
			provider.organizationId,
			"gitProviders",
			"delete",
		);
		if (role === "member" && provider.userId !== userId) {
			throw new ConvexError("You can only delete your own Git providers");
		}
		await removeProvider(ctx, gitProviderId);
	},
});

const validateName = (name: string) => {
	const trimmed = name.trim();
	if (!trimmed) throw new ConvexError("Name is required");
	return trimmed;
};

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		config: gitProviderConfig,
		connected: v.boolean(),
		secrets: v.array(encryptedProviderSecret),
	},
	handler: async (
		ctx,
		{ organizationId, name, config, connected, secrets },
	) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"gitProviders",
			"create",
		);
		const gitProviderId = await ctx.db.insert("gitProviders", {
			organizationId,
			userId,
			name: validateName(name),
			providerType: config.type,
			sharedWithOrganization: false,
			config,
			githubInstallationId:
				config.type === "github" ? config.installationId : undefined,
			connected,
		});
		await writeProviderSecrets(ctx, organizationId, gitProviderId, secrets);
		return gitProviderId;
	},
});

export const applyUpdate = internalMutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		name: v.optional(v.string()),
		config: gitProviderConfig,
		connected: v.optional(v.boolean()),
		secrets: v.array(encryptedProviderSecret),
	},
	handler: async (ctx, { gitProviderId, name, config, connected, secrets }) => {
		const { provider } = await loadProviderForManage(ctx, gitProviderId);
		if (config.type !== provider.providerType) {
			throw new ConvexError("Provider type cannot change");
		}
		await ctx.db.patch("gitProviders", gitProviderId, {
			...(name !== undefined ? { name: validateName(name) } : {}),
			config,
			...(connected !== undefined ? { connected } : {}),
		});
		await writeProviderSecrets(
			ctx,
			provider.organizationId,
			gitProviderId,
			secrets,
		);
	},
});

// Provider plus decrypted secrets for actions acting on behalf of a user who
// may use the provider. Never return the secrets to the client.
export const forUse = internalQuery({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider } = await loadProviderForUse(ctx, gitProviderId);
		return { provider, secrets: await readProviderSecrets(ctx, gitProviderId) };
	},
});

export const forManage = internalQuery({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider } = await loadProviderForManage(ctx, gitProviderId);
		return { provider, secrets: await readProviderSecrets(ctx, gitProviderId) };
	},
});

// No user check: for webhooks, OAuth callbacks (after their state check) and
// lease-guarded agent actions that have already authorized the caller.
export const forSystem = internalQuery({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (!provider) throw new ConvexError("Git provider not found");
		return { provider, secrets: await readProviderSecrets(ctx, gitProviderId) };
	},
});

export const touchGitea = internalMutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (provider?.config.type !== "gitea") return;
		await ctx.db.patch("gitProviders", gitProviderId, {
			config: { ...provider.config, lastAuthenticatedAt: Date.now() },
		});
	},
});
