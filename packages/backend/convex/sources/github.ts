import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	type ActionCtx,
	action,
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
} from "../_generated/server";
import {
	loadGrants,
	permissionsForMember,
	requirePermission,
} from "../lib/permissions";
import { loadProviderForManage } from "./access";
import { createOAuthState } from "./oauthStates";
import type { RemoteBranch, RemoteRepository } from "./remote";
import {
	encryptedProviderSecret,
	providerSecretKind,
	readSecret,
	writeProviderSecrets,
} from "./secrets";
import {
	assertRepoSegment,
	callbackUrls,
	dashboardUrl,
	parseGithubBaseUrl,
} from "./urls";

const randomSuffix = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

// Step 1 of connecting GitHub: the dashboard POSTs `manifest` to `formAction`,
// GitHub creates the app and redirects to /sources/github/setup with a code.
export const beginManifest = mutation({
	args: {
		organizationId: v.string(),
		githubUrl: v.optional(v.string()),
		// Create the app under this GitHub organization instead of the user.
		githubOrganization: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, githubUrl, githubOrganization }) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"gitProviders",
			"create",
		);
		const parsed = parseGithubBaseUrl(githubUrl);
		if ("error" in parsed) throw new ConvexError(parsed.error);
		const state = await createOAuthState(ctx, {
			organizationId,
			userId,
			purpose: "github.manifest",
			githubUrl: parsed.url,
		});
		const urls = callbackUrls();
		const date = new Date().toISOString().slice(0, 10);
		const manifest = {
			name: `Panara Cloud-${date}-${randomSuffix()}`,
			url: dashboardUrl("") || urls.githubSetup,
			redirect_url: urls.githubSetup,
			callback_urls: [urls.githubSetup],
			hook_attributes: { url: urls.githubWebhook },
			public: false,
			request_oauth_on_install: true,
			default_permissions: {
				contents: "read",
				metadata: "read",
				emails: "read",
				pull_requests: "write",
			},
			default_events: ["pull_request", "push"],
		};
		const owner = githubOrganization?.trim()
			? `/organizations/${encodeURIComponent(assertRepoSegment(githubOrganization, "GitHub organization"))}`
			: "";
		return {
			formAction: `${parsed.url}${owner}/settings/apps/new?state=${encodeURIComponent(state)}`,
			manifest: JSON.stringify(manifest),
		};
	},
});

// Step 2: install the created app on repositories. GitHub sends the browser
// back to /sources/github/setup with the installation id.
export const beginInstall = mutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const { provider, userId } = await loadProviderForManage(
			ctx,
			gitProviderId,
		);
		if (provider.config.type !== "github" || !provider.config.appName) {
			throw new ConvexError("This GitHub app has not been created yet");
		}
		const state = await createOAuthState(ctx, {
			organizationId: provider.organizationId,
			userId,
			purpose: "github.install",
			gitProviderId,
		});
		return `${provider.config.appName}/installations/new?state=${encodeURIComponent(state)}`;
	},
});

// Updates the display name and the app's page
// (https://<github>/apps/<slug>), from which install links are built.
export const update = mutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		name: v.string(),
		appName: v.string(),
	},
	handler: async (ctx, { gitProviderId, name, appName }) => {
		const { provider } = await loadProviderForManage(ctx, gitProviderId);
		if (provider.config.type !== "github") {
			throw new ConvexError("Not a GitHub provider");
		}
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Name is required");
		let appUrl: URL;
		try {
			appUrl = new URL(appName.trim());
		} catch {
			throw new ConvexError("App name must be the GitHub app URL");
		}
		const base = new URL(provider.config.githubUrl);
		if (
			appUrl.protocol !== "https:" ||
			appUrl.host !== base.host ||
			!/^\/apps\/[\w.-]+\/?$/.test(appUrl.pathname)
		) {
			throw new ConvexError(
				`App name must look like ${base.origin}/apps/<app-slug>`,
			);
		}
		await ctx.db.patch("gitProviders", gitProviderId, {
			name: trimmed,
			config: {
				...provider.config,
				appName: `${appUrl.origin}${appUrl.pathname.replace(/\/+$/, "")}`,
			},
		});
	},
});

const canCreateProviders = async (
	ctx: QueryCtx,
	organizationId: string,
	userId: string,
) => {
	const membership = await ctx.db
		.query("memberships")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.unique();
	if (!membership) return false;
	const grants =
		membership.role === "member"
			? await loadGrants(ctx, organizationId, userId)
			: null;
	return permissionsForMember(membership.role, grants).gitProviders.create;
};

// Callbacks run without a session; the consumed state names the user who
// started the flow, who must still hold gitProviders.create.
export const createFromManifest = internalMutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		name: v.string(),
		githubUrl: v.string(),
		appName: v.string(),
		appId: v.number(),
		clientId: v.string(),
		secrets: v.array(encryptedProviderSecret),
	},
	handler: async (ctx, args): Promise<Id<"gitProviders">> => {
		if (!(await canCreateProviders(ctx, args.organizationId, args.userId))) {
			throw new ConvexError("Requires the gitProviders.create permission");
		}
		const gitProviderId = await ctx.db.insert("gitProviders", {
			organizationId: args.organizationId,
			userId: args.userId,
			name: args.name,
			providerType: "github",
			sharedWithOrganization: false,
			config: {
				type: "github",
				githubUrl: args.githubUrl,
				appName: args.appName,
				appId: args.appId,
				clientId: args.clientId,
			},
			connected: false,
		});
		await writeProviderSecrets(
			ctx,
			args.organizationId,
			gitProviderId,
			args.secrets,
		);
		return gitProviderId;
	},
});

export const setInstallation = internalMutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		organizationId: v.string(),
		userId: v.string(),
		installationId: v.string(),
	},
	handler: async (ctx, args) => {
		const provider = await ctx.db.get("gitProviders", args.gitProviderId);
		if (
			!provider ||
			provider.organizationId !== args.organizationId ||
			provider.config.type !== "github"
		) {
			throw new ConvexError("GitHub provider not found");
		}
		if (!(await canCreateProviders(ctx, args.organizationId, args.userId))) {
			throw new ConvexError("Requires the gitProviders.create permission");
		}
		await ctx.db.patch("gitProviders", provider._id, {
			config: { ...provider.config, installationId: args.installationId },
			githubInstallationId: args.installationId,
			connected: true,
		});
	},
});

const requireUsableGithub = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	const { provider } = await ctx.runQuery(internal.sources.providers.forUse, {
		gitProviderId,
	});
	if (provider.config.type !== "github") {
		throw new ConvexError("Not a GitHub provider");
	}
};

export const listRepositories = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<RemoteRepository[]> => {
		await requireUsableGithub(ctx, gitProviderId);
		return await ctx.runAction(internal.sources.githubNode.listRepositories, {
			gitProviderId,
		});
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
		await requireUsableGithub(ctx, gitProviderId);
		return await ctx.runAction(internal.sources.githubNode.listBranches, {
			gitProviderId,
			owner: assertRepoSegment(owner, "owner"),
			repo: assertRepoSegment(repo, "repository"),
		});
	},
});

export const testConnection = action({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<string> => {
		await requireUsableGithub(ctx, gitProviderId);
		const repositories = await ctx.runAction(
			internal.sources.githubNode.listRepositories,
			{ gitProviderId },
		);
		return `Found ${repositories.length} repositories`;
	},
});

// Candidates for an incoming GitHub App webhook. The caller verifies the
// signature against each secret; installation ids are unique per app, so
// there is normally exactly one.
export const webhookTargets = internalQuery({
	args: { installationId: v.string() },
	handler: async (ctx, { installationId }) => {
		const providers = await ctx.db
			.query("gitProviders")
			.withIndex("by_githubInstallationId", (q) =>
				q.eq("githubInstallationId", installationId),
			)
			.take(5);
		const targets: {
			gitProviderId: Id<"gitProviders">;
			organizationId: string;
			webhookSecret: string;
		}[] = [];
		for (const provider of providers) {
			const webhookSecret = await readSecret(
				ctx,
				providerSecretKind("githubWebhookSecret"),
				provider._id,
			);
			if (webhookSecret) {
				targets.push({
					gitProviderId: provider._id,
					organizationId: provider.organizationId,
					webhookSecret,
				});
			}
		}
		return targets;
	},
});
