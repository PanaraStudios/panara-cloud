import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import type { GitProviderConfig } from "../tables/sources";
import {
	bitbucketBranches,
	bitbucketChangedFiles,
	bitbucketRepositories,
	type RemoteBranch,
	type RemoteRepository,
} from "./remote";
import { encryptProviderSecrets, type ProviderSecrets } from "./secrets";
import { assertRepoSegment } from "./urls";

type BitbucketConfig = Extract<GitProviderConfig, { type: "bitbucket" }>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authMode = (secrets: {
	apiToken?: string;
	appPassword?: string;
}): BitbucketConfig["authMode"] =>
	secrets.apiToken ? "apiToken" : secrets.appPassword ? "appPassword" : "none";

const fields = {
	username: v.optional(v.string()),
	email: v.optional(v.string()),
	workspaceName: v.optional(v.string()),
	// Leave empty to keep the stored value.
	appPassword: v.optional(v.string()),
	apiToken: v.optional(v.string()),
};

const cleanConfig = (
	base: Omit<BitbucketConfig, "type" | "authMode">,
	patch: { username?: string; email?: string; workspaceName?: string },
) => {
	const pick = (value: string | undefined, current: string | undefined) =>
		value === undefined ? current : value.trim() || undefined;
	const email = pick(patch.email, base.email);
	if (email && !EMAIL.test(email)) throw new ConvexError("Invalid email");
	return {
		username: pick(patch.username, base.username),
		email,
		workspaceName: pick(patch.workspaceName, base.workspaceName),
	};
};

const checkCredentials = (config: BitbucketConfig) => {
	if (config.authMode === "apiToken" && !config.email) {
		throw new ConvexError(
			"Atlassian account email is required when using an API token",
		);
	}
	if (config.authMode === "appPassword" && !config.username) {
		throw new ConvexError("Username is required when using an app password");
	}
	if (config.authMode === "none") {
		throw new ConvexError("An API token or app password is required");
	}
};

export const create = action({
	args: { organizationId: v.string(), name: v.string(), ...fields },
	handler: async (ctx, args): Promise<Id<"gitProviders">> => {
		await ctx.runQuery(internal.permissions.check, {
			organizationId: args.organizationId,
			resource: "gitProviders",
			action: "create",
		});
		const config: BitbucketConfig = {
			type: "bitbucket",
			...cleanConfig({}, args),
			authMode: authMode({
				apiToken: args.apiToken?.trim(),
				appPassword: args.appPassword?.trim(),
			}),
		};
		checkCredentials(config);
		return await ctx.runMutation(internal.sources.providers.insert, {
			organizationId: args.organizationId,
			name: args.name,
			config,
			connected: true,
			secrets: await encryptProviderSecrets({
				apiToken: args.apiToken?.trim(),
				appPassword: args.appPassword?.trim(),
			}),
		});
	},
});

export const update = action({
	args: {
		gitProviderId: v.id("gitProviders"),
		name: v.optional(v.string()),
		...fields,
	},
	handler: async (ctx, args): Promise<null> => {
		const { provider, secrets } = await ctx.runQuery(
			internal.sources.providers.forManage,
			{ gitProviderId: args.gitProviderId },
		);
		if (provider.config.type !== "bitbucket") {
			throw new ConvexError("Not a Bitbucket provider");
		}
		const apiToken = args.apiToken?.trim() || undefined;
		const appPassword = args.appPassword?.trim() || undefined;
		const config: BitbucketConfig = {
			type: "bitbucket",
			...cleanConfig(provider.config, args),
			authMode: authMode({
				apiToken: apiToken ?? secrets.apiToken,
				appPassword: appPassword ?? secrets.appPassword,
			}),
		};
		checkCredentials(config);
		await ctx.runMutation(internal.sources.providers.applyUpdate, {
			gitProviderId: args.gitProviderId,
			name: args.name,
			config,
			secrets: await encryptProviderSecrets({ apiToken, appPassword }),
		});
		return null;
	},
});

const usableBitbucket = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
): Promise<{ config: BitbucketConfig; secrets: ProviderSecrets }> => {
	const { provider, secrets } = await ctx.runQuery(
		internal.sources.providers.forUse,
		{ gitProviderId },
	);
	if (provider.config.type !== "bitbucket") {
		throw new ConvexError("Not a Bitbucket provider");
	}
	return { config: provider.config, secrets };
};

export const listRepositories = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<RemoteRepository[]> => {
		const { config, secrets } = await usableBitbucket(ctx, gitProviderId);
		return await bitbucketRepositories(config, secrets);
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
		const { config, secrets } = await usableBitbucket(ctx, gitProviderId);
		return await bitbucketBranches(
			config,
			secrets,
			assertRepoSegment(owner, "owner"),
			assertRepoSegment(repo, "repository"),
		);
	},
});

// Unsaved form values override the stored ones (empty tokens keep the stored
// secrets), so changes can be tested before saving.
export const testConnection = action({
	args: { gitProviderId: v.id("gitProviders"), ...fields },
	handler: async (ctx, { gitProviderId, ...form }): Promise<string> => {
		const overridesCredentials =
			form.username !== undefined ||
			form.email !== undefined ||
			form.apiToken !== undefined ||
			form.appPassword !== undefined;
		const { provider, secrets } = await ctx.runQuery(
			overridesCredentials
				? internal.sources.providers.forManage
				: internal.sources.providers.forUse,
			{ gitProviderId },
		);
		if (provider.config.type !== "bitbucket") {
			throw new ConvexError("Not a Bitbucket provider");
		}
		const merged: ProviderSecrets = {
			...secrets,
			apiToken: form.apiToken?.trim() || secrets.apiToken,
			appPassword: form.appPassword?.trim() || secrets.appPassword,
		};
		const config: BitbucketConfig = {
			type: "bitbucket",
			...cleanConfig(provider.config, form),
			authMode: authMode(merged),
		};
		checkCredentials(config);
		const repositories = await bitbucketRepositories(config, merged);
		return `Found ${repositories.length} repositories`;
	},
});

// For webhook handlers: Bitbucket push payloads don't list changed files.
// Returns null when they can't be determined (deploy anyway).
export const changedFiles = internalAction({
	args: {
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repoSlug: v.string(),
		changes: v.array(
			v.object({ newHash: v.string(), oldHash: v.optional(v.string()) }),
		),
	},
	handler: async (ctx, args): Promise<string[] | null> => {
		const { provider, secrets } = await ctx.runQuery(
			internal.sources.providers.forSystem,
			{ gitProviderId: args.gitProviderId },
		);
		if (provider.config.type !== "bitbucket") return null;
		return await bitbucketChangedFiles(
			provider.config,
			secrets,
			args.owner,
			args.repoSlug,
			args.changes,
		);
	},
});
