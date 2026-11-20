import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Role } from "../lib/access";
import { isAppNameInUse } from "../lib/appNames";
import { enqueueJob, type JobSpec } from "../lib/jobs";
import {
	type Access,
	type Action,
	type Resource,
	requireServicePermission,
} from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";

export const ENV_KIND = "application.env";
export const BUILD_ARGS_KIND = "application.buildArgs";
export const BUILD_SECRETS_KIND = "application.buildSecrets";
export const PREVIEW_ENV_KIND = "application.previewEnv";
export const PREVIEW_BUILD_ARGS_KIND = "application.previewBuildArgs";
export const PREVIEW_BUILD_SECRETS_KIND = "application.previewBuildSecrets";
export const DOCKER_PASSWORD_KIND = "application.dockerPassword";
export const ROLLBACK_CONTEXT_KIND = "application.rollbackContext";

export const APPLICATION_SECRET_KINDS = [
	ENV_KIND,
	BUILD_ARGS_KIND,
	BUILD_SECRETS_KIND,
	PREVIEW_ENV_KIND,
	PREVIEW_BUILD_ARGS_KIND,
	PREVIEW_BUILD_SECRETS_KIND,
	DOCKER_PASSWORD_KIND,
] as const;

export const MAX_APPLICATIONS_PER_ENVIRONMENT = 500;
export const MAX_ENV_LENGTH = 256 * 1024;

export const APP_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const BUILD_PATH_REGEX = /^([a-zA-Z0-9._@+/][a-zA-Z0-9._@+/-]*)?$/;
export const BUILD_TOKEN_REGEX = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

export const isSafeBuildPath = (value: string) =>
	BUILD_PATH_REGEX.test(value) && !value.split("/").includes("..");

export const applicationOwner = (applicationId: string) => ({
	kind: "application" as const,
	id: applicationId,
});

export const previewOwner = (previewId: string) => ({
	kind: "preview" as const,
	id: previewId,
});

export const applicationGroup = (applicationId: string) =>
	`application:${applicationId}`;

export const previewGroup = (previewId: string) => `preview:${previewId}`;

export const deployPartition = (app: Doc<"applications">): string =>
	app.serverId ?? LOCAL_PARTITION;

// Docker images are pulled where they run; everything else builds on the
// build server when one is set.
export const buildPartition = (app: Doc<"applications">): string =>
	app.source?.type === "docker"
		? deployPartition(app)
		: (app.buildServerId ?? app.serverId ?? LOCAL_PARTITION);

const WORDS = {
	verbs: [
		"back-up",
		"bypass",
		"hack",
		"override",
		"compress",
		"copy",
		"navigate",
		"index",
		"connect",
		"generate",
		"quantify",
		"calculate",
		"synthesize",
		"input",
		"transmit",
		"program",
		"reboot",
		"parse",
	],
	adjectives: [
		"auxiliary",
		"primary",
		"back-end",
		"digital",
		"open-source",
		"virtual",
		"cross-platform",
		"redundant",
		"online",
		"haptic",
		"multi-byte",
		"bluetooth",
		"wireless",
		"1080p",
		"neural",
		"optical",
		"solid-state",
		"mobile",
	],
	nouns: [
		"driver",
		"protocol",
		"bandwidth",
		"panel",
		"microchip",
		"program",
		"port",
		"card",
		"array",
		"interface",
		"system",
		"sensor",
		"firewall",
		"hard-drive",
		"pixel",
		"alarm",
		"feed",
		"monitor",
		"application",
		"transmitter",
		"bus",
		"circuit",
		"capacitor",
		"matrix",
	],
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Mutations get a deterministic, per-transaction PRNG, which is enough for
// names (uniqueness is checked separately).
export const randomString = (length: number): string =>
	Array.from(
		{ length },
		() => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
	).join("");

const pick = (list: string[]) =>
	list[Math.floor(Math.random() * list.length)] as string;

// Generated app names: `<type>-<verb>-<adjective>-<noun>-<6 chars>`.
export const generateAppName = (type: string): string =>
	`${type}-${pick(WORDS.verbs)}-${pick(WORDS.adjectives)}-${pick(WORDS.nouns)}-${randomString(6)}`;

// A user-provided name gets a random suffix.
export const buildAppName = (type: string, base?: string): string => {
	const trimmed = base?.trim();
	if (!trimmed) return generateAppName(type);
	const name = `${trimmed.slice(0, 55)}-${randomString(6)}`;
	if (!APP_NAME_REGEX.test(name)) {
		throw new ConvexError(
			"App name can only contain letters, numbers, dots, underscores and hyphens",
		);
	}
	return name;
};

export const isAppNameTaken = (
	ctx: QueryCtx,
	appName: string,
	exceptId?: Id<"applications">,
): Promise<boolean> => isAppNameInUse(ctx, appName, exceptId);

export const loadApplication = async (
	ctx: QueryCtx,
	applicationId: Id<"applications">,
): Promise<Doc<"applications">> => {
	const app = await ctx.db.get("applications", applicationId);
	if (!app) throw new ConvexError("Application not found");
	return app;
};

export const requireApplication = async <R extends Resource>(
	ctx: QueryCtx,
	applicationId: Id<"applications">,
	resource: R,
	action: Action<R>,
): Promise<{
	app: Doc<"applications">;
	userId: string;
	role: Role;
	access: Access;
}> => {
	const app = await loadApplication(ctx, applicationId);
	const access = await requireServicePermission(ctx, app, resource, action);
	return { app, userId: access.userId, role: access.role, access };
};

// Previews are scoped through their parent application.
export const requirePreview = async <R extends Resource>(
	ctx: QueryCtx,
	previewId: Id<"applicationPreviews">,
	resource: R,
	action: Action<R>,
) => {
	const preview = await ctx.db.get("applicationPreviews", previewId);
	if (!preview) throw new ConvexError("Preview deployment not found");
	const access = await requireServicePermission(
		ctx,
		{ _id: preview.applicationId, organizationId: preview.organizationId },
		resource,
		action,
	);
	return { preview, userId: access.userId, access };
};

const DEPLOY_KINDS = new Set([
	"application.deploy",
	"application.redeploy",
	"application.previewDeploy",
	"application.rollback",
]);

export const enqueueApplicationJob = async (
	ctx: MutationCtx,
	input: {
		organizationId: string;
		partition: string;
		group: string;
		spec: JobSpec;
		requestedBy?: string;
		idempotent?: boolean;
	},
): Promise<Id<"jobs">> =>
	await enqueueJob(ctx, {
		organizationId: input.organizationId,
		partition: input.partition,
		group: input.group,
		spec: input.spec,
		idempotent: input.idempotent ?? false,
		maxAttempts: input.idempotent ? 3 : 1,
		usesBuildSlot: DEPLOY_KINDS.has(input.spec.kind),
		requestedBy: input.requestedBy,
	});

// Inserts the deploy job and the `deployments` row users see in history.
export const enqueueDeployment = async (
	ctx: MutationCtx,
	input: {
		organizationId: string;
		partition: string;
		group: string;
		spec: JobSpec;
		target: { kind: "application" | "preview"; id: string };
		title: string;
		description?: string;
		commit?: { sha: string; message?: string };
		requestedBy?: string;
	},
): Promise<{ jobId: Id<"jobs">; deploymentId: Id<"deployments"> }> => {
	const jobId = await enqueueApplicationJob(ctx, input);
	const deploymentId = await ctx.db.insert("deployments", {
		organizationId: input.organizationId,
		jobId,
		target: input.target,
		title: input.title.slice(0, 500),
		description: input.description?.slice(0, 2000),
		commit: input.commit,
	});
	return { jobId, deploymentId };
};

// Jobs that would act on a deleted service are dropped; infra jobs in the
// same group (routing removal) still run.
export const cancelPendingJobs = async (ctx: MutationCtx, group: string) => {
	for (const status of ["queued", "running"] as const) {
		const jobs = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", group).eq("status", status),
			)
			.take(100);
		for (const job of jobs) {
			if (!job.spec.kind.startsWith("application.")) continue;
			if (job.spec.kind === "application.remove") continue;
			if (job.spec.kind === "application.previewRemove") continue;
			await ctx.db.patch(
				"jobs",
				job._id,
				status === "queued"
					? {
							status: "cancelled",
							cancelRequested: true,
							finishedAt: Date.now(),
						}
					: { cancelRequested: true },
			);
		}
	}
};

export const hasActiveJob = async (
	ctx: QueryCtx,
	group: string,
): Promise<boolean> => {
	for (const status of ["queued", "running"] as const) {
		const job = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", group).eq("status", status),
			)
			.first();
		if (job) return true;
	}
	return false;
};
