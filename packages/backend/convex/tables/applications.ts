import { defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import { mountOwner } from "../lib/mounts";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { certificateType } from "./infra";
import { appliedCutoffs } from "./serviceEvents";
import { gitSource } from "./sources";

export const applicationStatus = v.union(
	v.literal("idle"),
	v.literal("running"),
	v.literal("done"),
	v.literal("error"),
);

export const buildType = v.union(
	v.literal("dockerfile"),
	v.literal("heroku_buildpacks"),
	v.literal("paketo_buildpacks"),
	v.literal("nixpacks"),
	v.literal("static"),
	v.literal("railpack"),
);

export const triggerType = v.union(v.literal("push"), v.literal("tag"));

// Where the code or image comes from. A docker source's registry password
// lives in `secrets` (kind "application.dockerPassword"); a drop source's zip
// lives in Convex file storage.
export const applicationSource = v.union(
	v.object({ type: v.literal("git"), git: gitSource }),
	v.object({
		type: v.literal("docker"),
		image: v.string(),
		registryUrl: v.optional(v.string()),
		username: v.optional(v.string()),
	}),
	v.object({
		type: v.literal("drop"),
		buildPath: v.string(),
		storageId: v.optional(v.id("_storage")),
	}),
);

export const buildSettings = v.object({
	type: buildType,
	dockerfile: v.string(),
	dockerContextPath: v.optional(v.string()),
	dockerBuildStage: v.optional(v.string()),
	publishDirectory: v.optional(v.string()),
	isStaticSpa: v.boolean(),
	railpackVersion: v.string(),
	herokuVersion: v.string(),
	cleanCache: v.boolean(),
	createEnvFile: v.boolean(),
});

export const previewSettings = v.object({
	enabled: v.boolean(),
	// "*.example.com"; defaults to "*.sslip.io" (resolves to the server IP).
	wildcard: v.optional(v.string()),
	port: v.number(),
	https: v.boolean(),
	path: v.string(),
	certificateType,
	customCertResolver: v.optional(v.string()),
	limit: v.number(),
	// Only pull requests carrying one of these labels get a preview.
	labels: v.array(v.string()),
	requireCollaboratorPermissions: v.boolean(),
});

export const rollbackSettings = v.object({
	enabled: v.boolean(),
	// Number of previous images kept for rollback.
	keep: v.number(),
	// Push rollback images here; otherwise they stay on the deploy server.
	registryId: v.optional(v.id("registries")),
});

export const patchType = v.union(
	v.literal("create"),
	v.literal("update"),
	v.literal("delete"),
);

export type ApplicationSource = Infer<typeof applicationSource>;
export type BuildSettings = Infer<typeof buildSettings>;
export type PreviewSettings = Infer<typeof previewSettings>;

const applicationId = v.id("applications");

export const applicationsJobSpecs = [
	// Clone/pull/unzip, build, optionally push, then update the swarm service.
	// `trusted` on the jobs that run the Swarm service: bind mounts outside
	// the service's folder are applied only when set; see isTrustedJob in
	// lib/hostPolicy.ts.
	v.object({
		kind: v.literal("application.deploy"),
		applicationId,
		trusted: v.optional(v.boolean()),
	}),
	// Re-applies the service with the last image (rebuild: false) or rebuilds
	// the code already on the build server without cloning (rebuild: true).
	v.object({
		kind: v.literal("application.redeploy"),
		applicationId,
		rebuild: v.boolean(),
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("application.reload"),
		applicationId,
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("application.start"),
		applicationId,
		trusted: v.optional(v.boolean()),
	}),
	v.object({ kind: v.literal("application.stop"), applicationId }),
	// Runs after the application row is gone, so it carries what it needs.
	v.object({
		kind: v.literal("application.remove"),
		appName: v.string(),
		removeService: v.boolean(),
	}),
	v.object({
		kind: v.literal("application.previewDeploy"),
		previewId: v.id("applicationPreviews"),
		rebuild: v.boolean(),
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("application.previewRemove"),
		appName: v.string(),
	}),
	v.object({
		kind: v.literal("application.rollback"),
		applicationId,
		rollbackId: v.id("applicationRollbacks"),
		// The version's `appliedAt`, copied when queued because the row may
		// be pruned or removed while this job still decides what's pending.
		appliedAt: v.optional(appliedCutoffs),
		trusted: v.optional(v.boolean()),
	}),
	// Clones the repository (op "tree") or reads one file (op "read") so the
	// UI can create patches; results land in `applicationOps`.
	v.object({
		kind: v.literal("application.patchRepo"),
		applicationId,
		op: v.union(v.literal("tree"), v.literal("read")),
		path: v.optional(v.string()),
	}),
	// Moves the service (and its volume and bind mount data) to another
	// server, then queues a deploy there. Runs on the source server.
	v.object({
		kind: v.literal("application.transfer"),
		applicationId,
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.boolean(),
	}),
	// Deletes pruned rollback images from the registry they were pushed to.
	// Rows are already gone, so the spec carries the image references.
	v.object({
		kind: v.literal("application.rollbackImagesRemove"),
		applicationId,
		registryId: v.id("registries"),
		images: v.array(v.string()),
	}),
] as const;

// Secret kinds (rows in `secrets`, ownerId = the document id):
//   "application.env" / "application.buildArgs" / "application.buildSecrets"
//   "application.previewEnv" / "application.previewBuildArgs" /
//   "application.previewBuildSecrets"   dotenv text
//   "application.dockerPassword"        password for a docker source's registry
//   "application.rollbackContext"       JSON snapshot of a deployed version
//                                       (ownerId = applicationRollbacks id)
export const applicationsTables = {
	applications: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
		name: v.string(),
		appName: v.string(),
		description: v.optional(v.string()),
		// Data URL (bundled SVG or uploaded image) shown next to the name.
		icon: v.optional(v.string()),
		// Deploy target; the panel host when absent.
		serverId: v.optional(v.id("servers")),
		// Build elsewhere, push to `buildRegistryId` (or `registryId`), and let
		// the deploy server pull.
		buildServerId: v.optional(v.id("servers")),
		buildRegistryId: v.optional(v.id("registries")),
		// Push every built image here and deploy from it.
		registryId: v.optional(v.id("registries")),
		source: v.optional(applicationSource),
		// Duplicated from source.git so webhook events find their apps.
		gitProviderId: v.optional(v.id("gitProviders")),
		build: buildSettings,
		command: v.optional(v.string()),
		args: v.optional(v.array(v.string())),
		replicas: v.number(),
		...swarmSettings,
		...resourceSettings,
		autoDeploy: v.boolean(),
		triggerType,
		// Secret path segment of the deploy webhook URL.
		refreshToken: v.string(),
		preview: previewSettings,
		rollback: rollbackSettings,
		status: applicationStatus,
		// Image the service currently runs, for redeploys without a rebuild.
		lastImage: v.optional(v.string()),
		// Extra overlay networks (infra `networks` rows on the deploy server)
		// and whether the service leaves panara-cloud-network. Ignored when
		// networkSwarm is set.
		networkIds: v.optional(v.array(v.id("networks"))),
		detachPanaraCloudNetwork: v.optional(v.boolean()),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_environmentId", ["environmentId"])
		.index("by_serverId", ["serverId"])
		.index("by_buildServerId", ["buildServerId"])
		.index("by_appName", ["appName"])
		.index("by_refreshToken", ["refreshToken"])
		.index("by_gitProviderId", ["gitProviderId"])
		.index("by_status", ["status"]),

	// One per pull request and application.
	applicationPreviews: defineTable({
		organizationId: v.string(),
		applicationId,
		appName: v.string(),
		host: v.string(),
		domainId: v.optional(v.id("domains")),
		pullRequest: v.object({
			// Provider id of the pull request (stable across pushes).
			id: v.string(),
			number: v.number(),
			url: v.string(),
			title: v.string(),
			// Head branch the preview builds.
			branch: v.string(),
			headSha: v.optional(v.string()),
		}),
		// GitHub comment kept up to date with the preview status.
		commentId: v.optional(v.number()),
		status: applicationStatus,
		lastImage: v.optional(v.string()),
	})
		.index("by_applicationId", ["applicationId"])
		.index("by_applicationId_and_pullRequestId", [
			"applicationId",
			"pullRequest.id",
		])
		.index("by_appName", ["appName"])
		.index("by_status", ["status"]),

	// A deployed image that can be redeployed. The settings it ran with are an
	// encrypted secret (kind "application.rollbackContext").
	applicationRollbacks: defineTable({
		organizationId: v.string(),
		applicationId,
		deploymentId: v.optional(v.id("deployments")),
		version: v.number(),
		// What the service pulls: a registry tag or a local `<appName>:v<n>`.
		image: v.string(),
		// Local tag on the deploy server, removed when the version expires.
		localTag: v.string(),
		registryId: v.optional(v.id("registries")),
		// What of the settings the snapshot holds had been applied when the
		// deploy that took it succeeded; a rollback restores these cutoffs.
		appliedAt: v.optional(appliedCutoffs),
	}).index("by_applicationId_and_version", ["applicationId", "version"]),

	// Files changed in the repository before each build. Owned by a service
	// ({ kind: "application" | "compose", id }); content lives in
	// `patchContents` so lists stay small.
	patches: defineTable({
		organizationId: v.string(),
		owner: mountOwner,
		filePath: v.string(),
		type: patchType,
		enabled: v.boolean(),
		updatedAt: v.number(),
	}).index("by_owner_and_filePath", ["owner.kind", "owner.id", "filePath"]),

	patchContents: defineTable({
		organizationId: v.string(),
		patchId: v.id("patches"),
		content: v.string(),
	}).index("by_patchId", ["patchId"]),

	// Results of one-off jobs (patch repository listings and file reads).
	applicationOps: defineTable({
		organizationId: v.string(),
		jobId: v.id("jobs"),
		result: v.optional(v.string()),
		error: v.optional(v.string()),
		completedAt: v.optional(v.number()),
	}).index("by_jobId", ["jobId"]),
};
