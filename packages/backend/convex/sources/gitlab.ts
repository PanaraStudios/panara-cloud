import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, mutation } from "../_generated/server";
import type { GitProviderConfig } from "../tables/sources";
import { loadProviderForManage } from "./access";
import { createOAuthState } from "./oauthStates";
import {
	filterGitlabProjects,
	gitlabBranches,
	gitlabProjects,
	gitlabRepositories,
	type RemoteBranch,
	type RemoteRepository,
} from "./remote";
import { encryptProviderSecrets } from "./secrets";
import { getAccessToken } from "./tokens";
import { callbackUrls, DEFAULT_GITLAB_URL, parseInstanceUrl } from "./urls";

type GitlabConfig = Extract<GitProviderConfig, { type: "gitlab" }>;

const optionalUrl = (value: string | undefined) =>
	value?.trim() ? parseInstanceUrl(value, "GitLab internal") : undefined;

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		gitlabUrl: v.optional(v.string()),
		internalUrl: v.optional(v.string()),
		applicationId: v.string(),
		secret: v.string(),
		groupName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<"gitProviders">> => {
		await ctx.runQuery(internal.permissions.check, {
			organizationId: args.organizationId,
			resource: "gitProviders",
			action: "create",
		});
		if (!args.applicationId.trim() || !args.secret.trim()) {
			throw new ConvexError("Application ID and secret are required");
		}
		return await ctx.runMutation(internal.sources.providers.insert, {
			organizationId: args.organizationId,
			name: args.name,
			config: {
				type: "gitlab",
				gitlabUrl: parseInstanceUrl(
					args.gitlabUrl || DEFAULT_GITLAB_URL,
					"GitLab",
				),
				internalUrl: optionalUrl(args.internalUrl),
				applicationId: args.applicationId.trim(),
				groupName: args.groupName?.trim() || undefined,
			},
			connected: false,
			secrets: await encryptProviderSecrets({
				clientSecret: args.secret.trim(),
			}),
		});
	},
});

export const update = action({
	args: {
		gitProviderId: v.id("gitProviders"),
		name: v.optional(v.string()),
		gitlabUrl: v.optional(v.string()),
		internalUrl: v.optional(v.string()),
		applicationId: v.optional(v.string()),
		// Leave empty to keep the stored secret.
		secret: v.optional(v.string()),
		groupName: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<null> => {
		const { provider } = await ctx.runQuery(
			internal.sources.providers.forManage,
			{ gitProviderId: args.gitProviderId },
		);
		if (provider.config.type !== "gitlab") {
			throw new ConvexError("Not a GitLab provider");
		}
		const config: GitlabConfig = {
			...provider.config,
			...(args.gitlabUrl !== undefined
				? { gitlabUrl: parseInstanceUrl(args.gitlabUrl, "GitLab") }
				: {}),
			...(args.internalUrl !== undefined
				? { internalUrl: optionalUrl(args.internalUrl) }
				: {}),
			...(args.applicationId?.trim()
				? { applicationId: args.applicationId.trim() }
				: {}),
			...(args.groupName !== undefined
				? { groupName: args.groupName.trim() || undefined }
				: {}),
		};
		// The client secret and OAuth tokens would otherwise be sent to the
		// new instance.
		const moved =
			config.gitlabUrl !== provider.config.gitlabUrl ||
			config.internalUrl !== provider.config.internalUrl;
		if (moved && !args.secret?.trim()) {
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
				clientSecret: args.secret?.trim(),
				...(moved ? { tokens: null } : {}),
			}),
		});
		return null;
	},
});

// Returns the GitLab authorization URL to send the browser to.
export const beginAuthorize = mutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider, userId } = await loadProviderForManage(
			ctx,
			gitProviderId,
		);
		const { config } = provider;
		if (config.type !== "gitlab" || !config.applicationId) {
			throw new ConvexError("GitLab application is not configured");
		}
		const state = await createOAuthState(ctx, {
			organizationId: provider.organizationId,
			userId,
			purpose: "gitlab.authorize",
			gitProviderId,
		});
		const url = new URL(`${config.gitlabUrl}/oauth/authorize`);
		url.searchParams.set("client_id", config.applicationId);
		url.searchParams.set("redirect_uri", callbackUrls().gitlab);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", "api read_user read_repository");
		url.searchParams.set("state", state);
		return url.toString();
	},
});

const usableGitlab = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	const { provider } = await ctx.runQuery(internal.sources.providers.forUse, {
		gitProviderId,
	});
	if (provider.config.type !== "gitlab") {
		throw new ConvexError("Not a GitLab provider");
	}
	return {
		config: provider.config,
		accessToken: await getAccessToken(ctx, gitProviderId),
	};
};

export const listRepositories = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<RemoteRepository[]> => {
		const { config, accessToken } = await usableGitlab(ctx, gitProviderId);
		return await gitlabRepositories(config, accessToken);
	},
});

export const listBranches = action({
	args: { gitProviderId: v.id("gitProviders"), projectId: v.number() },
	handler: async (
		ctx,
		{ gitProviderId, projectId },
	): Promise<RemoteBranch[]> => {
		if (!Number.isInteger(projectId) || projectId <= 0) return [];
		const { config, accessToken } = await usableGitlab(ctx, gitProviderId);
		return await gitlabBranches(config, accessToken, projectId);
	},
});

export const testConnection = action({
	args: {
		gitProviderId: v.id("gitProviders"),
		groupName: v.optional(v.string()),
	},
	handler: async (ctx, { gitProviderId, groupName }): Promise<string> => {
		const { config, accessToken } = await usableGitlab(ctx, gitProviderId);
		const projects = filterGitlabProjects(
			await gitlabProjects(config, accessToken),
			groupName ?? config.groupName,
		);
		return `Found ${projects.length} repositories`;
	},
});
