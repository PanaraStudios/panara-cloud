import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, mutation } from "../_generated/server";
import type { GitProviderConfig } from "../tables/sources";
import { loadProviderForManage } from "./access";
import { createOAuthState } from "./oauthStates";
import {
	giteaBranches,
	giteaRepositories,
	type RemoteBranch,
	type RemoteRepository,
} from "./remote";
import { encryptProviderSecrets } from "./secrets";
import { getAccessToken } from "./tokens";
import {
	assertBackendCanReach,
	assertRepoSegment,
	callbackUrls,
	DEFAULT_GITEA_URL,
	parseInstanceUrl,
} from "./urls";

type GiteaConfig = Extract<GitProviderConfig, { type: "gitea" }>;

const DEFAULT_SCOPES = "read:repository read:user read:organization";

const optionalUrl = (value: string | undefined) =>
	value?.trim() ? parseInstanceUrl(value, "Gitea internal") : undefined;

const optionalOrganization = (value: string | undefined) =>
	value?.trim() ? assertRepoSegment(value, "organization name") : undefined;

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		giteaUrl: v.optional(v.string()),
		internalUrl: v.optional(v.string()),
		clientId: v.string(),
		clientSecret: v.string(),
		scopes: v.optional(v.string()),
		organizationName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<"gitProviders">> => {
		await ctx.runQuery(internal.permissions.check, {
			organizationId: args.organizationId,
			resource: "gitProviders",
			action: "create",
		});
		if (!args.clientId.trim() || !args.clientSecret.trim()) {
			throw new ConvexError("Client ID and secret are required");
		}
		const giteaUrl = parseInstanceUrl(
			args.giteaUrl || DEFAULT_GITEA_URL,
			"Gitea",
		);
		const internalUrl = optionalUrl(args.internalUrl);
		assertBackendCanReach(giteaUrl, internalUrl);
		return await ctx.runMutation(internal.sources.providers.insert, {
			organizationId: args.organizationId,
			name: args.name,
			config: {
				type: "gitea",
				giteaUrl,
				internalUrl,
				clientId: args.clientId.trim(),
				scopes: args.scopes?.trim() || undefined,
				organizationName: optionalOrganization(args.organizationName),
			},
			connected: false,
			secrets: await encryptProviderSecrets({
				clientSecret: args.clientSecret.trim(),
			}),
		});
	},
});

export const update = action({
	args: {
		gitProviderId: v.id("gitProviders"),
		name: v.optional(v.string()),
		giteaUrl: v.optional(v.string()),
		internalUrl: v.optional(v.string()),
		clientId: v.optional(v.string()),
		// Leave empty to keep the stored secret.
		clientSecret: v.optional(v.string()),
		scopes: v.optional(v.string()),
		// Empty clears it.
		organizationName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<null> => {
		const { provider } = await ctx.runQuery(
			internal.sources.providers.forManage,
			{ gitProviderId: args.gitProviderId },
		);
		if (provider.config.type !== "gitea") {
			throw new ConvexError("Not a Gitea provider");
		}
		const config: GiteaConfig = {
			...provider.config,
			...(args.giteaUrl !== undefined
				? { giteaUrl: parseInstanceUrl(args.giteaUrl, "Gitea") }
				: {}),
			...(args.internalUrl !== undefined
				? { internalUrl: optionalUrl(args.internalUrl) }
				: {}),
			...(args.clientId?.trim() ? { clientId: args.clientId.trim() } : {}),
			...(args.scopes !== undefined
				? { scopes: args.scopes.trim() || undefined }
				: {}),
			...(args.organizationName !== undefined
				? { organizationName: optionalOrganization(args.organizationName) }
				: {}),
		};
		// The client secret and OAuth tokens would otherwise be sent to the
		// new instance.
		const moved =
			config.giteaUrl !== provider.config.giteaUrl ||
			config.internalUrl !== provider.config.internalUrl;
		if (moved) assertBackendCanReach(config.giteaUrl, config.internalUrl);
		if (moved && !args.clientSecret?.trim()) {
			throw new ConvexError(
				"Enter the client secret again when changing the instance URL",
			);
		}
		await ctx.runMutation(internal.sources.providers.applyUpdate, {
			gitProviderId: args.gitProviderId,
			name: args.name,
			config,
			...(moved ? { connected: false } : {}),
			secrets: await encryptProviderSecrets({
				clientSecret: args.clientSecret?.trim(),
				...(moved ? { tokens: null } : {}),
			}),
		});
		return null;
	},
});

export const beginAuthorize = mutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider, userId } = await loadProviderForManage(
			ctx,
			gitProviderId,
		);
		const { config } = provider;
		if (config.type !== "gitea" || !config.clientId) {
			throw new ConvexError("Gitea OAuth application is not configured");
		}
		const state = await createOAuthState(ctx, {
			organizationId: provider.organizationId,
			userId,
			purpose: "gitea.authorize",
			gitProviderId,
		});
		const url = new URL(`${config.giteaUrl}/login/oauth/authorize`);
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", callbackUrls().gitea);
		url.searchParams.set("scope", config.scopes ?? DEFAULT_SCOPES);
		url.searchParams.set("state", state);
		return url.toString();
	},
});

const usableGitea = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	const { provider } = await ctx.runQuery(internal.sources.providers.forUse, {
		gitProviderId,
	});
	if (provider.config.type !== "gitea") {
		throw new ConvexError("Not a Gitea provider");
	}
	return {
		config: provider.config,
		accessToken: await getAccessToken(ctx, gitProviderId),
	};
};

export const listRepositories = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<RemoteRepository[]> => {
		const { config, accessToken } = await usableGitea(ctx, gitProviderId);
		return await giteaRepositories(config, accessToken);
	},
});

export const listBranches = action({
	args: {
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repo: v.string(),
	},
	handler: async (
		ctx,
		{ gitProviderId, owner, repo },
	): Promise<RemoteBranch[]> => {
		const { config, accessToken } = await usableGitea(ctx, gitProviderId);
		return await giteaBranches(
			config,
			accessToken,
			assertRepoSegment(owner, "owner"),
			assertRepoSegment(repo, "repository"),
		);
	},
});

export const testConnection = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<string> => {
		const { config, accessToken } = await usableGitea(ctx, gitProviderId);
		const repositories = await giteaRepositories(config, accessToken);
		await ctx.runMutation(internal.sources.providers.touchGitea, {
			gitProviderId,
		});
		return `Found ${repositories.length} repositories`;
	},
});
