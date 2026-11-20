import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "../_generated/server";

const SECURITY_MARKER = "<!-- panara-cloud-preview-security -->";

const statusLabel = {
	initializing: "🔄 Building",
	running: "🔄 Building",
	success: "✅ Done",
	error: "❌ Failed",
} as const;

export const previewComment = (
	name: string,
	status: keyof typeof statusLabel,
	url: string,
	now = new Date(),
) => `### Panara Cloud Preview Deployment

| Name       | Status       | Preview                             | Updated (UTC)         |
|------------|--------------|-------------------------------------|-----------------------|
| ${name}  | ${statusLabel[status]} | [Preview URL](${url}) | ${now.toISOString()} |
`;

const securityComment = (
	author: string,
	repository: string,
	permission: string | null,
) => `${SECURITY_MARKER}
### 🚨 Preview Deployment Blocked - Security Protection

Your pull request was blocked from triggering preview deployments: **${author}** does not have write access to **${repository}** (permission: ${permission ?? "none"}).

Preview deployments run the pull request's code on the deployment servers, so only collaborators with write access may trigger them. A maintainer can grant access or disable "Require collaborator permissions" in the application's preview settings.`;

export const handlePullRequest = internalAction({
	args: {
		organizationId: v.string(),
		gitProviderId: v.id("gitProviders"),
		applicationIds: v.array(v.id("applications")),
		owner: v.string(),
		repository: v.string(),
		create: v.boolean(),
		pullRequest: v.object({
			id: v.string(),
			number: v.number(),
			url: v.string(),
			title: v.string(),
			branch: v.string(),
			headSha: v.optional(v.string()),
			labels: v.array(v.string()),
			author: v.string(),
		}),
	},
	handler: async (ctx, args): Promise<Id<"applicationPreviews">[]> => {
		const settings = await ctx.runQuery(
			internal.applications.previewActions.previewRequirements,
			{ applicationIds: args.applicationIds },
		);
		let permission: {
			hasWriteAccess: boolean;
			permission: string | null;
		} | null = null;
		if (settings.some((app) => app.requireCollaboratorPermissions)) {
			permission = args.pullRequest.author
				? await ctx.runAction(
						internal.sources.githubNode.collaboratorPermission,
						{
							gitProviderId: args.gitProviderId,
							owner: args.owner,
							repo: args.repository,
							username: args.pullRequest.author,
						},
					)
				: { hasWriteAccess: false, permission: null };
		}
		const allowed = settings
			.filter(
				(app) =>
					!app.requireCollaboratorPermissions || permission?.hasWriteAccess,
			)
			.map((app) => app.applicationId);
		if (allowed.length < settings.length) {
			const target = {
				gitProviderId: args.gitProviderId,
				owner: args.owner,
				repo: args.repository,
			};
			const posted = await ctx.runAction(
				internal.sources.githubNode.issueHasCommentContaining,
				{
					...target,
					issueNumber: args.pullRequest.number,
					marker: SECURITY_MARKER,
				},
			);
			if (!posted) {
				await ctx
					.runAction(internal.sources.githubNode.createIssueComment, {
						...target,
						issueNumber: args.pullRequest.number,
						body: securityComment(
							args.pullRequest.author || "unknown",
							args.repository,
							permission?.permission ?? null,
						),
					})
					.catch(() => null);
			}
		}
		if (allowed.length === 0) return [];
		const { author: _, ...pullRequest } = args.pullRequest;
		return await ctx.runMutation(
			internal.applications.gitEvents.deployPreviews,
			{
				organizationId: args.organizationId,
				applicationIds: allowed,
				create: args.create,
				pullRequest,
			},
		);
	},
});

export const previewRequirements = internalQuery({
	args: { applicationIds: v.array(v.id("applications")) },
	handler: async (ctx, { applicationIds }) => {
		const result = [];
		for (const applicationId of applicationIds) {
			const app = await ctx.db.get("applications", applicationId);
			if (!app) continue;
			result.push({
				applicationId,
				requireCollaboratorPermissions:
					app.preview.requireCollaboratorPermissions,
			});
		}
		return result;
	},
});

export const commentContext = internalQuery({
	args: { previewId: v.id("applicationPreviews") },
	handler: async (ctx, { previewId }) => {
		const preview = await ctx.db.get("applicationPreviews", previewId);
		if (!preview) return null;
		const app = await ctx.db.get("applications", preview.applicationId);
		const source = app?.source?.type === "git" ? app.source.git : null;
		if (!app || source?.type !== "github") return null;
		return {
			name: app.name,
			gitProviderId: source.gitProviderId,
			owner: source.owner,
			repo: source.repository,
			issueNumber: preview.pullRequest.number,
			commentId: preview.commentId ?? null,
			url: `${app.preview.https ? "https" : "http"}://${preview.host}`,
		};
	},
});

export const setComment = internalMutation({
	args: { previewId: v.id("applicationPreviews"), commentId: v.number() },
	handler: async (ctx, { previewId, commentId }) => {
		if (await ctx.db.get("applicationPreviews", previewId)) {
			await ctx.db.patch("applicationPreviews", previewId, { commentId });
		}
	},
});

// Creates or updates the preview's status comment on the pull request.
export const syncComment = internalAction({
	args: {
		previewId: v.id("applicationPreviews"),
		status: v.union(
			v.literal("initializing"),
			v.literal("running"),
			v.literal("success"),
			v.literal("error"),
		),
	},
	handler: async (ctx, { previewId, status }): Promise<null> => {
		const context = await ctx.runQuery(
			internal.applications.previewActions.commentContext,
			{ previewId },
		);
		if (!context) return null;
		const target = {
			gitProviderId: context.gitProviderId,
			owner: context.owner,
			repo: context.repo,
		};
		const body = previewComment(context.name, status, context.url);
		if (context.commentId !== null) {
			const updated = await ctx.runAction(
				internal.sources.githubNode.updateIssueComment,
				{ ...target, commentId: context.commentId, body },
			);
			if (updated) return null;
		}
		const created = await ctx.runAction(
			internal.sources.githubNode.createIssueComment,
			{ ...target, issueNumber: context.issueNumber, body },
		);
		await ctx.runMutation(internal.applications.previewActions.setComment, {
			previewId,
			commentId: created.commentId,
		});
		return null;
	},
});
