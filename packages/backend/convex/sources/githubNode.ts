"use node";

import { createAppAuth } from "@octokit/auth-app";
import { ConvexError, v } from "convex/values";
import { Octokit } from "octokit";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import type { RemoteBranch, RemoteRepository } from "./remote";
import { deriveGithubApiUrl } from "./urls";

const MAX_PAGES = 20;

// Callers authorize before invoking these internal actions.
const appOctokit = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
): Promise<Octokit> => {
	const { provider, secrets } = await ctx.runQuery(
		internal.sources.providers.forSystem,
		{ gitProviderId },
	);
	const { config } = provider;
	if (
		config.type !== "github" ||
		!config.appId ||
		!config.installationId ||
		!secrets.githubPrivateKey
	) {
		throw new ConvexError("GitHub provider is not configured correctly");
	}
	return new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: config.appId,
			privateKey: secrets.githubPrivateKey,
			installationId: config.installationId,
		},
		baseUrl: deriveGithubApiUrl(config.githubUrl),
	});
};

const target = {
	gitProviderId: v.id("gitProviders"),
	owner: v.string(),
	repo: v.string(),
};

// Installation tokens are valid for one hour and scoped to the repositories
// the app was installed on.
export const installationToken = internalAction({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const octokit = await appOctokit(ctx, gitProviderId);
		const auth = (await octokit.auth({ type: "installation" })) as {
			token: string;
			expiresAt: string;
		};
		return { token: auth.token, expiresAt: Date.parse(auth.expiresAt) };
	},
});

export const listRepositories = internalAction({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }): Promise<RemoteRepository[]> => {
		const octokit = await appOctokit(ctx, gitProviderId);
		const repositories: RemoteRepository[] = [];
		let pages = 0;
		for await (const { data } of octokit.paginate.iterator(
			octokit.rest.apps.listReposAccessibleToInstallation,
			{ per_page: 100 },
		)) {
			// paginate() flattens { repositories: [...] } pages into arrays at
			// runtime; the types still describe the raw response.
			const page = data as unknown as {
				id: number;
				name: string;
				full_name: string;
				html_url: string;
				owner: { login: string };
			}[];
			for (const repo of page) {
				repositories.push({
					id: repo.id,
					name: repo.name,
					owner: repo.owner.login,
					fullName: repo.full_name,
					url: repo.html_url,
				});
			}
			if (++pages >= MAX_PAGES) break;
		}
		return repositories;
	},
});

export const listBranches = internalAction({
	args: target,
	handler: async (
		ctx,
		{ gitProviderId, owner, repo },
	): Promise<RemoteBranch[]> => {
		const octokit = await appOctokit(ctx, gitProviderId);
		const branches: RemoteBranch[] = [];
		let pages = 0;
		for await (const { data } of octokit.paginate.iterator(
			octokit.rest.repos.listBranches,
			{ owner, repo, per_page: 100 },
		)) {
			for (const branch of data) {
				branches.push({ name: branch.name, commitSha: branch.commit.sha });
			}
			if (++pages >= MAX_PAGES) break;
		}
		return branches;
	},
});

const WRITE_PERMISSIONS = ["write", "admin", "maintain"];

// Preview deployments run the PR's code, so only collaborators with write
// access may trigger them. A non-collaborator gets a 404 from GitHub.
export const collaboratorPermission = internalAction({
	args: { ...target, username: v.string() },
	handler: async (ctx, { gitProviderId, owner, repo, username }) => {
		const octokit = await appOctokit(ctx, gitProviderId);
		try {
			const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username,
			});
			return {
				hasWriteAccess: WRITE_PERMISSIONS.includes(data.permission),
				permission: data.permission as string | null,
			};
		} catch {
			return { hasWriteAccess: false, permission: null };
		}
	},
});

export const createIssueComment = internalAction({
	args: { ...target, issueNumber: v.number(), body: v.string() },
	handler: async (ctx, { gitProviderId, owner, repo, issueNumber, body }) => {
		const octokit = await appOctokit(ctx, gitProviderId);
		const { data } = await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body,
		});
		return { commentId: data.id, url: data.html_url };
	},
});

// Returns false when the comment no longer exists.
export const updateIssueComment = internalAction({
	args: { ...target, commentId: v.number(), body: v.string() },
	handler: async (ctx, { gitProviderId, owner, repo, commentId, body }) => {
		const octokit = await appOctokit(ctx, gitProviderId);
		try {
			await octokit.rest.issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body,
			});
			return true;
		} catch {
			return false;
		}
	},
});

// Used to avoid posting the same notice twice on a pull request.
export const issueHasCommentContaining = internalAction({
	args: { ...target, issueNumber: v.number(), marker: v.string() },
	handler: async (ctx, { gitProviderId, owner, repo, issueNumber, marker }) => {
		const octokit = await appOctokit(ctx, gitProviderId);
		try {
			let pages = 0;
			for await (const { data } of octokit.paginate.iterator(
				octokit.rest.issues.listComments,
				{ owner, repo, issue_number: issueNumber, per_page: 100 },
			)) {
				if (data.some((comment) => comment.body?.includes(marker))) return true;
				if (++pages >= MAX_PAGES) break;
			}
		} catch {
			return false;
		}
		return false;
	},
});
