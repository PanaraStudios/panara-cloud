import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, query } from "../_generated/server";
import {
	assertHostsFree,
	registerRoutingOwner,
	removeRoutingOwner,
} from "../infra/routing";
import { normalizeHost } from "../infra/validation";
import { requireServicePermission } from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";
import {
	applicationOwner,
	buildPartition,
	cancelPendingJobs,
	deployPartition,
	enqueueApplicationJob,
	enqueueDeployment,
	isAppNameTaken,
	previewGroup,
	previewOwner,
	randomString,
	requireApplication,
	requirePreview,
} from "./lib";

const MAX_PREVIEWS = 100;

export type PullRequestInfo = {
	id: string;
	number: number;
	url: string;
	title: string;
	branch: string;
	headSha?: string;
	labels: string[];
};

export type CommentStatus = "initializing" | "running" | "success" | "error";

export const scheduleCommentSync = async (
	ctx: MutationCtx,
	previewId: Id<"applicationPreviews">,
	status: CommentStatus,
) => {
	await ctx.scheduler.runAfter(
		0,
		internal.applications.previewActions.syncComment,
		{ previewId, status },
	);
};

const serverIp = async (
	ctx: MutationCtx,
	serverId: Id<"servers"> | undefined,
) => {
	if (serverId) {
		const server = await ctx.db.get("servers", serverId);
		if (server?.ipAddress) return server.ipAddress;
	}
	const settings = await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();
	return settings?.serverIp ?? "127.0.0.1";
};

// Builds a preview's wildcard domain. Labels are capped at 63 characters, so
// long app names are shortened.
export const previewHost = (
	wildcard: string,
	appName: string,
	ip: string,
): string => {
	if (!wildcard.startsWith("*.")) {
		throw new ConvexError('The base domain must start with "*."');
	}
	if (wildcard.includes("sslip.io")) {
		const slugIp = ip.replaceAll(".", "-").replaceAll(":", "-");
		const label = `${appName.slice(0, 62 - slugIp.length)}-${slugIp}`;
		return normalizeHost(wildcard.replace("*", label.toLowerCase()));
	}
	return normalizeHost(
		wildcard.replace("*", appName.slice(0, 63).toLowerCase()),
	);
};

const previewEligible = (
	app: Doc<"applications">,
	pullRequest: PullRequestInfo,
) =>
	app.preview.labels.length === 0 ||
	pullRequest.labels.some((label) => app.preview.labels.includes(label));

// Creates the preview for a pull request if needed (respecting the label
// filter and the per-app limit) and queues its deployment. Returns null when
// the pull request doesn't get a preview.
export const deployPreviewForPullRequest = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
	pullRequest: PullRequestInfo,
	options: { create: boolean; requestedBy?: string },
): Promise<Id<"applicationPreviews"> | null> => {
	if (!previewEligible(app, pullRequest)) return null;
	let preview = await ctx.db
		.query("applicationPreviews")
		.withIndex("by_applicationId_and_pullRequestId", (q) =>
			q.eq("applicationId", app._id).eq("pullRequest.id", pullRequest.id),
		)
		.unique();
	const info = {
		id: pullRequest.id,
		number: pullRequest.number,
		url: pullRequest.url,
		title: pullRequest.title,
		branch: pullRequest.branch,
		headSha: pullRequest.headSha,
	};
	if (preview) {
		await ctx.db.patch("applicationPreviews", preview._id, {
			pullRequest: info,
		});
	} else {
		if (!options.create) return null;
		// The limit only applies to new previews; existing ones keep updating.
		const existing = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_applicationId", (q) => q.eq("applicationId", app._id))
			.take(app.preview.limit + 1);
		if (existing.length >= app.preview.limit) return null;
		const previewId = await createPreview(ctx, app, info);
		preview = await ctx.db.get("applicationPreviews", previewId);
		if (!preview) return null;
		await scheduleCommentSync(ctx, previewId, "initializing");
	}
	await enqueueDeployment(ctx, {
		organizationId: app.organizationId,
		partition: buildPartition(app),
		group: previewGroup(preview._id),
		spec: {
			kind: "application.previewDeploy",
			previewId: preview._id,
			rebuild: false,
		},
		target: previewOwner(preview._id),
		title: "Preview Deployment",
		description: pullRequest.headSha
			? `Hash: ${pullRequest.headSha}`
			: undefined,
		requestedBy: options.requestedBy,
	});
	return preview._id;
};

const createPreview = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
	pullRequest: Doc<"applicationPreviews">["pullRequest"],
): Promise<Id<"applicationPreviews">> => {
	let appName = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		appName = `preview-${app.appName.slice(0, 40)}-${randomString(6)}`;
		if (!(await isAppNameTaken(ctx, appName))) break;
	}
	const host = previewHost(
		app.preview.wildcard ?? "*.sslip.io",
		appName,
		await serverIp(ctx, app.serverId),
	);
	const previewId = await ctx.db.insert("applicationPreviews", {
		organizationId: app.organizationId,
		applicationId: app._id,
		appName,
		host,
		pullRequest,
		status: "idle",
	});
	const owner = previewOwner(previewId);
	await registerRoutingOwner(ctx, {
		organizationId: app.organizationId,
		owner,
		serverId: app.serverId,
		appName,
		parent: applicationOwner(app._id),
	});
	const domain = {
		organizationId: app.organizationId,
		owner,
		serverId: app.serverId,
		host,
		path: app.preview.path,
		port: app.preview.port,
		https: app.preview.https,
		certificateType: app.preview.certificateType,
		customCertResolver: app.preview.customCertResolver,
		internalPath: "/",
		stripPath: false,
		middlewares: [],
		enabled: true,
	};
	await assertHostsFree(ctx, app.serverId, [domain]);
	const domainId = await ctx.db.insert("domains", domain);
	await ctx.db.patch("applicationPreviews", previewId, { domainId });
	return previewId;
};

// Deletes the preview, its routing and deployment history, and removes its
// service and code from the hosts.
export const removePreview = async (
	ctx: MutationCtx,
	preview: Doc<"applicationPreviews">,
	partitions: { deploy: string; build: string },
	requestedBy?: string,
) => {
	await ctx.db.delete("applicationPreviews", preview._id);
	const group = previewGroup(preview._id);
	await cancelPendingJobs(ctx, group);
	await removeRoutingOwner(ctx, previewOwner(preview._id), requestedBy);
	for (const partition of new Set([partitions.deploy, partitions.build])) {
		await enqueueApplicationJob(ctx, {
			organizationId: preview.organizationId,
			partition,
			group,
			spec: { kind: "application.previewRemove", appName: preview.appName },
			idempotent: true,
			requestedBy,
		});
	}
	const deployments = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", "preview").eq("target.id", preview._id),
		)
		.take(200);
	for (const deployment of deployments) {
		await ctx.db.delete("deployments", deployment._id);
	}
};

export const listByApplication = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return [];
		await requireServicePermission(ctx, app, "deployment", "read");
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_applicationId", (q) =>
				q.eq("applicationId", applicationId),
			)
			.order("desc")
			.take(MAX_PREVIEWS);
		return await Promise.all(
			previews.map(async (preview) => {
				const domain = preview.domainId
					? await ctx.db.get("domains", preview.domainId)
					: null;
				return {
					...preview,
					domain: domain
						? {
								domainId: domain._id,
								host: domain.host,
								https: domain.https,
								path: domain.path,
							}
						: null,
				};
			}),
		);
	},
});

export const get = query({
	args: { previewId: v.id("applicationPreviews") },
	handler: async (ctx, { previewId }) => {
		const preview = await ctx.db.get("applicationPreviews", previewId);
		if (!preview) return null;
		await requireServicePermission(
			ctx,
			{ _id: preview.applicationId, organizationId: preview.organizationId },
			"deployment",
			"read",
		);
		return preview;
	},
});

export const remove = mutation({
	args: { previewId: v.id("applicationPreviews") },
	handler: async (ctx, { previewId }) => {
		const preview = await ctx.db.get("applicationPreviews", previewId);
		if (!preview) return;
		const { userId } = await requireServicePermission(
			ctx,
			{ _id: preview.applicationId, organizationId: preview.organizationId },
			"deployment",
			"cancel",
		);
		const app = await ctx.db.get("applications", preview.applicationId);
		const partition = app ? deployPartition(app) : LOCAL_PARTITION;
		await removePreview(
			ctx,
			preview,
			{ deploy: partition, build: app ? buildPartition(app) : partition },
			userId,
		);
	},
});

// Rebuilds the code already on the build server (rebuild: true, a
// preview redeploy) or clones the pull request branch again.
export const redeploy = mutation({
	args: {
		previewId: v.id("applicationPreviews"),
		rebuild: v.optional(v.boolean()),
		title: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { previewId, rebuild, title, description }) => {
		const { preview, userId } = await requirePreview(
			ctx,
			previewId,
			"deployment",
			"create",
		);
		const { app } = await requireApplication(
			ctx,
			preview.applicationId,
			"deployment",
			"create",
		);
		return await enqueueDeployment(ctx, {
			organizationId: app.organizationId,
			partition: buildPartition(app),
			group: previewGroup(previewId),
			spec: {
				kind: "application.previewDeploy",
				previewId,
				rebuild: rebuild ?? true,
			},
			target: previewOwner(previewId),
			title: title || "Rebuild Preview Deployment",
			description,
			requestedBy: userId,
		});
	},
});
