import { defineTable } from "convex/server";
import { type Infer, v } from "convex/values";

export const gitProviderType = v.union(
	v.literal("github"),
	v.literal("gitlab"),
	v.literal("gitea"),
	v.literal("bitbucket"),
);

// Fields every git source shares, wherever the code comes from.
const gitSourceCommon = {
	branch: v.string(),
	// Directory inside the repository to build from ("/" for the root).
	buildPath: v.string(),
	submodules: v.boolean(),
	// Globs (micromatch syntax) that must match a changed file for a push to
	// trigger a deploy; empty or absent means every push deploys.
	watchPaths: v.optional(v.array(v.string())),
};

// Where an application or compose project gets its code. Embed this in your
// own tables and job snapshots, validate it with `assertGitSourceAccess`
// (convex/sources/lib.ts) when a user saves it, and pass it to
// `api.sources.agent.mintCloneCredentials` from the agent before cloning.
export const gitSource = v.union(
	v.object({
		type: v.literal("github"),
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repository: v.string(),
		...gitSourceCommon,
	}),
	v.object({
		type: v.literal("gitlab"),
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repository: v.string(),
		// "group/subgroup/repo"; GitLab clones by namespace path.
		pathNamespace: v.string(),
		// Numeric project id, needed to list branches.
		projectId: v.optional(v.number()),
		...gitSourceCommon,
	}),
	v.object({
		type: v.literal("gitea"),
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repository: v.string(),
		...gitSourceCommon,
	}),
	v.object({
		type: v.literal("bitbucket"),
		gitProviderId: v.id("gitProviders"),
		owner: v.string(),
		repository: v.string(),
		repositorySlug: v.optional(v.string()),
		...gitSourceCommon,
	}),
	v.object({
		type: v.literal("git"),
		// https://... or an SSH remote (git@host:owner/repo.git, ssh://...).
		url: v.string(),
		sshKeyId: v.optional(v.id("sshKeys")),
		...gitSourceCommon,
	}),
);

export type GitSource = Infer<typeof gitSource>;

// A push, tag or pull request event after signature verification, in the
// same shape for every provider. Produced by `parseGitWebhook`
// (convex/sources/webhooks.ts) and passed to `<domain>/gitEvents:handle`.
export const gitEvent = v.object({
	provider: v.union(gitProviderType, v.literal("soft-serve")),
	kind: v.union(
		v.literal("push"),
		v.literal("tag"),
		v.literal("pull_request"),
		v.literal("ping"),
		v.literal("other"),
	),
	repo: v.object({
		owner: v.string(),
		name: v.string(),
		fullName: v.string(),
		// Bitbucket repository slug or GitLab project path, when they differ.
		slug: v.optional(v.string()),
		projectId: v.optional(v.number()),
	}),
	branch: v.optional(v.string()),
	tag: v.optional(v.string()),
	commitSha: v.optional(v.string()),
	commitMessage: v.string(),
	// Every path added, modified or removed by the pushed commits. null when
	// the payload doesn't list them (Bitbucket): treat as "unknown, deploy".
	changedFiles: v.union(v.array(v.string()), v.null()),
	// Bitbucket only: commit ranges for `internal.sources.bitbucket.changedFiles`.
	bitbucketChanges: v.optional(
		v.array(v.object({ newHash: v.string(), oldHash: v.optional(v.string()) })),
	),
	pullRequest: v.optional(
		v.object({
			id: v.number(),
			number: v.number(),
			action: v.string(),
			title: v.string(),
			url: v.string(),
			headBranch: v.string(),
			headSha: v.string(),
			baseBranch: v.string(),
			author: v.string(),
			labels: v.array(v.string()),
		}),
	),
	// GitHub App installation that sent the event.
	installationId: v.optional(v.string()),
	// Commit message contains [skip ci] or an equivalent keyword.
	skipCi: v.boolean(),
});

export type GitEvent = Infer<typeof gitEvent>;

export const githubConfig = v.object({
	type: v.literal("github"),
	githubUrl: v.string(),
	// The app's html_url (https://github.com/apps/<slug>); install links hang off it.
	appName: v.optional(v.string()),
	appId: v.optional(v.number()),
	clientId: v.optional(v.string()),
	installationId: v.optional(v.string()),
});

export const gitlabConfig = v.object({
	type: v.literal("gitlab"),
	gitlabUrl: v.string(),
	// Reachable from Convex when the public URL isn't (same-host installs).
	internalUrl: v.optional(v.string()),
	applicationId: v.optional(v.string()),
	groupName: v.optional(v.string()),
});

export const giteaConfig = v.object({
	type: v.literal("gitea"),
	giteaUrl: v.string(),
	internalUrl: v.optional(v.string()),
	clientId: v.optional(v.string()),
	scopes: v.optional(v.string()),
	// Repositories of this organization are listed next to the user's own.
	organizationName: v.optional(v.string()),
	lastAuthenticatedAt: v.optional(v.number()),
});

export const bitbucketConfig = v.object({
	type: v.literal("bitbucket"),
	username: v.optional(v.string()),
	email: v.optional(v.string()),
	workspaceName: v.optional(v.string()),
	authMode: v.union(
		v.literal("apiToken"),
		v.literal("appPassword"),
		v.literal("none"),
	),
});

export const gitProviderConfig = v.union(
	githubConfig,
	gitlabConfig,
	giteaConfig,
	bitbucketConfig,
);

export type GitProviderConfig = Infer<typeof gitProviderConfig>;

export const oauthPurpose = v.union(
	v.literal("github.manifest"),
	v.literal("github.install"),
	v.literal("gitlab.authorize"),
	v.literal("gitea.authorize"),
);

export const registryTestStatus = v.union(
	v.literal("pending"),
	v.literal("succeeded"),
	v.literal("failed"),
);

export const sourcesJobSpecs = [
	// `docker login` on a server (or the panel host) to check and persist
	// registry credentials.
	v.object({
		kind: v.literal("sources.registryTest"),
		testId: v.id("registryTests"),
	}),
	v.object({
		kind: v.literal("sources.registryLogout"),
		registryUrl: v.string(),
	}),
] as const;

// Secret kinds (rows in `secrets`, ownerId = the document id):
//   "sources.gitProvider.credentials"  JSON ProviderCredentials (app key, client secret, ...)
//   "sources.gitProvider.tokens"       JSON OAuthTokens (GitLab/Gitea access + refresh)
//   "sources.registry.password"        registry password
//   "sources.registryTest.password"    password of an unsaved registry under test
export const sourcesTables = {
	gitProviders: defineTable({
		organizationId: v.string(),
		// Creator; members only see providers they created or that are shared.
		userId: v.string(),
		name: v.string(),
		providerType: gitProviderType,
		sharedWithOrganization: v.boolean(),
		config: gitProviderConfig,
		// Duplicated from config so GitHub webhooks can find their provider.
		githubInstallationId: v.optional(v.string()),
		// OAuth providers (GitLab/Gitea) only become usable after authorization.
		connected: v.boolean(),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_githubInstallationId", ["githubInstallationId"]),

	// Expiry and refresh lock for OAuth tokens, apart from `gitProviders` so a
	// refresh doesn't invalidate provider lists. GitLab refresh tokens are
	// single-use, so only the holder of `lockId` may spend one.
	gitProviderTokens: defineTable({
		organizationId: v.string(),
		gitProviderId: v.id("gitProviders"),
		// Seconds since epoch, as the providers report it.
		expiresAt: v.optional(v.number()),
		version: v.number(),
		lockId: v.optional(v.string()),
		lockExpiresAt: v.optional(v.number()),
	}).index("by_gitProviderId", ["gitProviderId"]),

	// Single-use `state` values for OAuth / GitHub App redirects. Callbacks hit
	// the Convex site without a user session, so the state is what binds a
	// callback to the admin who started the flow.
	oauthStates: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		purpose: oauthPurpose,
		stateHash: v.string(),
		gitProviderId: v.optional(v.id("gitProviders")),
		githubUrl: v.optional(v.string()),
		expiresAt: v.number(),
	})
		.index("by_stateHash", ["stateHash"])
		.index("by_expiresAt", ["expiresAt"]),

	registries: defineTable({
		organizationId: v.string(),
		registryName: v.string(),
		imagePrefix: v.optional(v.string()),
		username: v.string(),
		// hostname[:port]; empty for Docker Hub.
		registryUrl: v.string(),
		registryType: v.union(v.literal("cloud"), v.literal("selfHosted")),
	}).index("by_organizationId", ["organizationId"]),

	// One `docker login` check, either of a saved registry or of credentials
	// typed into the form before saving.
	registryTests: defineTable({
		organizationId: v.string(),
		registryId: v.optional(v.id("registries")),
		registryUrl: v.string(),
		username: v.string(),
		serverId: v.optional(v.id("servers")),
		jobId: v.optional(v.id("jobs")),
		status: registryTestStatus,
		error: v.optional(v.string()),
		finishedAt: v.optional(v.number()),
	})
		.index("by_jobId", ["jobId"])
		.index("by_registryId", ["registryId"]),
};
