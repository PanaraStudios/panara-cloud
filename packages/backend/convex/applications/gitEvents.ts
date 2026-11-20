import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { eventRepoMatches, shouldDeploy } from "../sources/lib";
import { gitEvent } from "../tables/sources";
import { queueDeploy } from "./deploy";
import { buildPartition, deployPartition } from "./lib";
import { deployPreviewForPullRequest, removePreview } from "./previews";

const MAX_APPS = 500;

const CLOSE_ACTIONS = new Set([
	"closed",
	"close",
	"merge",
	"merged",
	"fulfilled",
	"rejected",
	"declined",
]);
const UPDATE_ACTIONS = new Set([
	"opened",
	"synchronize",
	"reopened",
	"labeled",
	"unlabeled",
	"open",
	"reopen",
	"update",
	"created",
	"updated",
]);

const gitSourceOf = (app: Doc<"applications">) =>
	app.source?.type === "git" ? app.source.git : null;

// Verified git provider events (the GitHub App route in sources/http.ts
// forwards here): push and tag events deploy matching applications, pull
// request events create, update or remove preview deployments.
export const handle = internalMutation({
	args: {
		organizationId: v.string(),
		gitProviderId: v.id("gitProviders"),
		event: gitEvent,
	},
	handler: async (ctx, { organizationId, gitProviderId, event }) => {
		const apps = (
			await ctx.db
				.query("applications")
				.withIndex("by_gitProviderId", (q) =>
					q.eq("gitProviderId", gitProviderId),
				)
				.take(MAX_APPS)
		).filter((app) => {
			const source = gitSourceOf(app);
			return (
				app.organizationId === organizationId &&
				source !== null &&
				source.type === event.provider &&
				eventRepoMatches(event, source)
			);
		});

		if (event.kind === "push" || event.kind === "tag") {
			if (event.skipCi) return { triggered: 0 };
			let triggered = 0;
			for (const app of apps) {
				const source = gitSourceOf(app);
				if (!source || !app.autoDeploy) continue;
				if (event.kind === "tag") {
					if (app.triggerType !== "tag") continue;
				} else if (
					app.triggerType !== "push" ||
					event.branch !== source.branch ||
					!shouldDeploy(source.watchPaths, event.changedFiles)
				) {
					continue;
				}
				await queueDeploy(ctx, app, {
					title:
						event.kind === "tag"
							? `Tag created: ${event.tag ?? ""}`
							: event.commitMessage,
					description: event.commitSha ? `Hash: ${event.commitSha}` : undefined,
					commit: event.commitSha
						? { sha: event.commitSha, message: event.commitMessage }
						: undefined,
				});
				triggered++;
			}
			return { triggered };
		}

		const pullRequest = event.pullRequest;
		if (event.kind !== "pull_request" || !pullRequest) return { triggered: 0 };
		const previewApps = apps.filter(
			(app) =>
				app.preview.enabled &&
				gitSourceOf(app)?.branch === pullRequest.baseBranch,
		);
		const pullRequestId = String(pullRequest.id);

		if (CLOSE_ACTIONS.has(pullRequest.action)) {
			let removed = 0;
			for (const app of apps) {
				const preview = await ctx.db
					.query("applicationPreviews")
					.withIndex("by_applicationId_and_pullRequestId", (q) =>
						q.eq("applicationId", app._id).eq("pullRequest.id", pullRequestId),
					)
					.unique();
				if (!preview) continue;
				await removePreview(ctx, preview, {
					deploy: deployPartition(app),
					build: buildPartition(app),
				});
				removed++;
			}
			return { triggered: removed };
		}

		if (!UPDATE_ACTIONS.has(pullRequest.action) || previewApps.length === 0) {
			return { triggered: 0 };
		}
		// Preview builds run the pull request's code, so the author's
		// repository permission is checked (an action) before anything deploys.
		await ctx.scheduler.runAfter(
			0,
			internal.applications.previewActions.handlePullRequest,
			{
				organizationId,
				gitProviderId,
				applicationIds: previewApps.map((app) => app._id),
				owner: event.repo.owner,
				repository: event.repo.name,
				create: pullRequest.action !== "unlabeled",
				pullRequest: {
					id: pullRequestId,
					number: pullRequest.number,
					url: pullRequest.url,
					title: pullRequest.title || `#${pullRequest.number}`,
					branch: pullRequest.headBranch,
					headSha: pullRequest.headSha || undefined,
					labels: pullRequest.labels,
					author: pullRequest.author,
				},
			},
		);
		return { triggered: previewApps.length };
	},
});

export const deployPreviews = internalMutation({
	args: {
		organizationId: v.string(),
		applicationIds: v.array(v.id("applications")),
		create: v.boolean(),
		pullRequest: v.object({
			id: v.string(),
			number: v.number(),
			url: v.string(),
			title: v.string(),
			branch: v.string(),
			headSha: v.optional(v.string()),
			labels: v.array(v.string()),
		}),
	},
	handler: async (
		ctx,
		{ organizationId, applicationIds, create, pullRequest },
	) => {
		const previews = [];
		for (const applicationId of applicationIds) {
			const app = await ctx.db.get("applications", applicationId);
			if (
				!app ||
				app.organizationId !== organizationId ||
				!app.preview.enabled
			) {
				continue;
			}
			const previewId = await deployPreviewForPullRequest(
				ctx,
				app,
				pullRequest,
				{
					create,
				},
			);
			if (previewId) previews.push(previewId);
		}
		return previews;
	},
});
