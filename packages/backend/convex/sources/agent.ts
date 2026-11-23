import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import { requireLease } from "../lib/lease";
import { gitSource } from "../tables/sources";
import {
	assertGitSourceInOrganization,
	getRegistryCredentials as registryCredentials,
} from "./lib";
import {
	deleteSecret,
	REGISTRY_PASSWORD_KIND,
	REGISTRY_TEST_PASSWORD_KIND,
	readProviderSecrets,
	readSecret,
} from "./secrets";
import { getAccessToken } from "./tokens";
import { normalizeGithubUrl, splitBasicAuth } from "./urls";

const lease = { jobId: v.id("jobs"), leaseId: v.string() };

export type CloneCredentials =
	| { type: "basic"; username: string; password: string }
	| { type: "ssh"; privateKey: string };

// Everything `cloneRepository` (apps/agent/src/sources/clone.ts) needs except
// the destination. `url` never contains credentials.
export type CloneSpec = {
	url: string;
	branch: string;
	submodules: boolean;
	credentials: CloneCredentials | null;
	// Milliseconds since epoch; null when the credentials don't expire.
	expiresAt: number | null;
};

export const cloneContext = internalQuery({
	args: { ...lease, source: gitSource },
	handler: async (ctx, { jobId, leaseId, source }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		await assertGitSourceInOrganization(ctx, job.organizationId, source);
		if (source.type === "git") {
			const privateKey = source.sshKeyId
				? await readSecret(ctx, "sshPrivateKey", source.sshKeyId)
				: null;
			if (source.sshKeyId && privateKey === null) {
				throw new ConvexError("SSH private key missing");
			}
			return { kind: "git" as const, privateKey };
		}
		const provider = await ctx.db.get("gitProviders", source.gitProviderId);
		if (!provider) throw new ConvexError("Git provider not found");
		return {
			kind: "provider" as const,
			provider,
			secrets: await readProviderSecrets(ctx, provider._id),
		};
	},
});

export const markSshKeyUsed = internalMutation({
	args: { sshKeyId: v.id("sshKeys") },
	handler: async (ctx, { sshKeyId }) => {
		if (await ctx.db.get("sshKeys", sshKeyId)) {
			await ctx.db.patch("sshKeys", sshKeyId, { lastUsedAt: Date.now() });
		}
	},
});

const httpBase = (url: string) => splitBasicAuth(url).url;

// Moves credentials typed into a custom https URL out of it, so they never
// land in the cloned repository's remote config.
const splitUrlCredentials = (
	url: string,
): { url: string; credentials: CloneCredentials | null } => {
	if (!/^https?:\/\//i.test(url)) return { url, credentials: null };
	const parsed = new URL(url);
	if (!parsed.username && !parsed.password) return { url, credentials: null };
	const credentials: CloneCredentials = {
		type: "basic",
		username: decodeURIComponent(parsed.username) || "git",
		password: decodeURIComponent(parsed.password),
	};
	parsed.username = "";
	parsed.password = "";
	return { url: parsed.toString(), credentials };
};

// Short-lived credentials to clone `source` for a job. GitHub gets a fresh
// installation token, GitLab/Gitea a refreshed OAuth token. The provider must
// belong to the job's organization.
export const mintCloneCredentials = action({
	args: { ...lease, source: gitSource },
	handler: async (ctx, { jobId, leaseId, source }): Promise<CloneSpec> => {
		const context = await ctx.runQuery(internal.sources.agent.cloneContext, {
			jobId,
			leaseId,
			source,
		});
		const common = { branch: source.branch, submodules: source.submodules };
		if (source.type === "git" || context.kind === "git") {
			if (source.type !== "git" || context.kind !== "git") {
				throw new ConvexError("Unexpected source");
			}
			if (source.sshKeyId) {
				await ctx.runMutation(internal.sources.agent.markSshKeyUsed, {
					sshKeyId: source.sshKeyId,
				});
			}
			if (context.privateKey) {
				return {
					...common,
					url: source.url.trim(),
					credentials: { type: "ssh", privateKey: context.privateKey },
					expiresAt: null,
				};
			}
			return {
				...common,
				...splitUrlCredentials(source.url.trim()),
				expiresAt: null,
			};
		}

		const { provider, secrets } = context;
		const { config } = provider;
		switch (source.type) {
			case "github": {
				if (config.type !== "github") break;
				const { token, expiresAt } = await ctx.runAction(
					internal.sources.githubNode.installationToken,
					{ gitProviderId: provider._id },
				);
				return {
					...common,
					url: `${normalizeGithubUrl(config.githubUrl)}/${source.owner}/${source.repository}.git`,
					credentials: {
						type: "basic",
						username: "x-access-token",
						password: token,
					},
					expiresAt,
				};
			}
			case "gitlab":
			case "gitea": {
				if (config.type !== "gitlab" && config.type !== "gitea") break;
				const accessToken = await getAccessToken(ctx, provider._id);
				const tokenState = await ctx.runQuery(
					internal.sources.agent.tokenExpiry,
					{ gitProviderId: provider._id },
				);
				const base = httpBase(
					config.type === "gitlab"
						? config.internalUrl || config.gitlabUrl
						: config.internalUrl || config.giteaUrl,
				);
				const path =
					source.type === "gitlab"
						? source.pathNamespace
						: `${source.owner}/${source.repository}`;
				return {
					...common,
					url: `${base}/${path}.git`,
					credentials: {
						type: "basic",
						username: "oauth2",
						password: accessToken,
					},
					expiresAt: tokenState,
				};
			}
			case "bitbucket": {
				if (config.type !== "bitbucket") break;
				const url = `https://bitbucket.org/${source.owner}/${source.repositorySlug || source.repository}.git`;
				if (secrets.apiToken) {
					return {
						...common,
						url,
						credentials: {
							type: "basic",
							username: "x-bitbucket-api-token-auth",
							password: secrets.apiToken,
						},
						expiresAt: null,
					};
				}
				if (!config.username || !secrets.appPassword) {
					throw new ConvexError("Bitbucket provider has no credentials");
				}
				return {
					...common,
					url,
					credentials: {
						type: "basic",
						username: config.username,
						password: secrets.appPassword,
					},
					expiresAt: null,
				};
			}
		}
		throw new ConvexError("Git provider does not match the source type");
	},
});

export const tokenExpiry = internalQuery({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const row = await ctx.db
			.query("gitProviderTokens")
			.withIndex("by_gitProviderId", (q) =>
				q.eq("gitProviderId", gitProviderId),
			)
			.unique();
		return row?.expiresAt ? row.expiresAt * 1000 : null;
	},
});

// Registry credentials for a job's build or deploy (e.g. to push or pull a
// private image). The registry must belong to the job's organization.
export const getRegistryCredentials = query({
	args: { ...lease, registryId: v.id("registries") },
	handler: async (ctx, { jobId, leaseId, registryId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		return await registryCredentials(ctx, job.organizationId, registryId);
	},
});

const loadTest = async (
	ctx: Parameters<typeof requireLease>[0],
	jobId: Id<"jobs">,
	leaseId: string,
) => {
	const { job } = await requireLease(ctx, jobId, leaseId);
	if (job.spec.kind !== "sources.registryTest") {
		throw new ConvexError("Not a registry test job");
	}
	const test = await ctx.db.get("registryTests", job.spec.testId);
	if (!test || test.organizationId !== job.organizationId) {
		throw new ConvexError("Registry test not found");
	}
	return test;
};

export const getRegistryTestContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const test = await loadTest(ctx, jobId, leaseId);
		const password = test.registryId
			? await readSecret(ctx, REGISTRY_PASSWORD_KIND, test.registryId)
			: await readSecret(ctx, REGISTRY_TEST_PASSWORD_KIND, test._id);
		if (password === null) throw new ConvexError("Registry password missing");
		return {
			registryUrl: test.registryUrl,
			username: test.username,
			password,
		};
	},
});

export const reportRegistryTest = mutation({
	args: { ...lease, ok: v.boolean(), error: v.optional(v.string()) },
	handler: async (ctx, { jobId, leaseId, ok, error }) => {
		const test = await loadTest(ctx, jobId, leaseId);
		await ctx.db.patch("registryTests", test._id, {
			status: ok ? "succeeded" : "failed",
			error: ok ? undefined : (error ?? "docker login failed").slice(0, 2000),
			finishedAt: Date.now(),
		});
		await deleteSecret(ctx, REGISTRY_TEST_PASSWORD_KIND, test._id);
	},
});
