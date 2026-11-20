import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	internalQuery,
} from "../_generated/server";
import {
	extractImageName,
	extractImageTag,
	parseGitWebhook,
	parseImagePushEvent,
	shouldDeploy,
} from "../sources/lib";
import type { GitEvent, GitSource } from "../tables/sources";
import { queueDeploy } from "./deploy";

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

export const lookup = internalQuery({
	args: { refreshToken: v.string() },
	handler: async (ctx, { refreshToken }) => {
		const app = await ctx.db
			.query("applications")
			.withIndex("by_refreshToken", (q) => q.eq("refreshToken", refreshToken))
			.unique();
		if (!app) return null;
		return {
			applicationId: app._id,
			autoDeploy: app.autoDeploy,
			triggerType: app.triggerType,
			source: app.source ?? null,
		};
	},
});

export const enqueue = internalMutation({
	args: {
		applicationId: v.id("applications"),
		refreshToken: v.string(),
		title: v.string(),
		description: v.optional(v.string()),
		commit: v.optional(
			v.object({ sha: v.string(), message: v.optional(v.string()) }),
		),
	},
	handler: async (ctx, { applicationId, refreshToken, ...input }) => {
		const app = await ctx.db.get("applications", applicationId);
		// The token may have been rotated while the request was processed.
		if (!app || app.refreshToken !== refreshToken || !app.autoDeploy) {
			return null;
		}
		const { jobId } = await queueDeploy(ctx, app, input);
		return jobId;
	},
});

const json = (status: number, message: string) =>
	Response.json({ message }, { status });

const gitChecks = async (
	ctx: ActionCtx,
	triggerType: "push" | "tag",
	source: GitSource,
	event: GitEvent,
): Promise<string | null> => {
	const tagTrigger = triggerType === "tag" && event.kind === "tag";
	if (
		!tagTrigger &&
		(event.kind !== "push" || event.branch !== source.branch)
	) {
		return "Branch Not Match";
	}
	let changedFiles = event.changedFiles;
	if (
		changedFiles === null &&
		source.type === "bitbucket" &&
		event.bitbucketChanges?.length
	) {
		changedFiles = await ctx
			.runAction(internal.sources.bitbucket.changedFiles, {
				gitProviderId: source.gitProviderId,
				owner: source.owner,
				repoSlug: source.repositorySlug ?? source.repository,
				changes: event.bitbucketChanges,
			})
			.catch(() => null);
	}
	if (!shouldDeploy(source.watchPaths, changedFiles)) {
		return "Watch Paths Not Match";
	}
	return null;
};

// POST /api/deploy/<refreshToken>: generic git providers and Docker Hub /
// GHCR image pushes. The unguessable token authenticates the request; status
// codes (including 301 for mismatches) are part of the webhook's contract.
export const handleDeployWebhook = async (
	ctx: ActionCtx,
	req: Request,
	refreshToken: string,
): Promise<Response> => {
	if (req.headers.get("x-github-event") === "ping") {
		return json(200, "Ping received, webhook is active");
	}
	if (
		!refreshToken ||
		refreshToken.includes("/") ||
		refreshToken.length > 128
	) {
		return json(404, "Application Not Found");
	}
	const raw = await req.arrayBuffer();
	if (raw.byteLength > MAX_WEBHOOK_BYTES) return json(413, "Payload too large");
	const app = await ctx.runQuery(internal.applications.webhooks.lookup, {
		refreshToken,
	});
	if (!app) return json(404, "Application Not Found");
	if (!app.autoDeploy) {
		return json(400, "Automatic deployments are disabled for this application");
	}
	let body: unknown = {};
	try {
		body = raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {};
	} catch {
		body = {};
	}

	let title = "Manual deployment";
	let description: string | undefined;
	let commit: { sha: string; message?: string } | undefined;

	const source = app.source;
	if (source?.type === "docker") {
		const push = parseImagePushEvent(req.headers, body);
		const imageName = extractImageName(source.image);
		const imageTag = extractImageTag(source.image);
		if (!imageName) return json(301, "Application Docker Image Name Not Found");
		if (push) {
			if (push.imageName !== imageName) {
				return json(
					301,
					`Application Image Name (${imageName}) doesn't match request event payload Image Name (${push.imageName}).`,
				);
			}
			if (!push.tag) {
				return json(200, "Untagged image version, skipping deployment");
			}
			if (push.tag !== imageTag) {
				return json(
					301,
					`Application Image Tag (${imageTag}) doesn't match request event payload Image Tag (${push.tag}).`,
				);
			}
			title = push.title;
		}
	} else if (source?.type === "git") {
		const parsed = await parseGitWebhook(req.headers, raw);
		if (!parsed.ok) return json(301, "Branch Not Match");
		const event = parsed.event;
		const rejection = await gitChecks(ctx, app.triggerType, source.git, event);
		if (rejection) return json(301, rejection);
		title =
			event.kind === "tag" && event.tag
				? `Tag created: ${event.tag}`
				: event.commitMessage;
		if (event.commitSha) {
			description = `Hash: ${event.commitSha}`;
			commit = { sha: event.commitSha, message: event.commitMessage };
		}
	} else if (!source) {
		return json(400, "Error deploying Application");
	}

	const jobId: Id<"jobs"> | null = await ctx.runMutation(
		internal.applications.webhooks.enqueue,
		{
			applicationId: app.applicationId,
			refreshToken,
			title,
			description,
			commit,
		},
	);
	if (!jobId) return json(404, "Application Not Found");
	return json(200, "Application deployed successfully");
};
