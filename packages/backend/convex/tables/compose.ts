import { defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import { composeType } from "./infra";
import { gitSource } from "./sources";

export const composeStatus = v.union(
	v.literal("idle"),
	v.literal("running"),
	v.literal("done"),
	v.literal("error"),
);

export const composeTriggerType = v.union(v.literal("push"), v.literal("tag"));

// Extra networks (infra `networks` rows) joined by one compose service, and
// whether it leaves panara-cloud-network.
export const composeServiceNetwork = v.object({
	serviceName: v.string(),
	networkIds: v.array(v.id("networks")),
	detachPanaraCloudNetwork: v.boolean(),
});

export type ComposeServiceNetwork = Infer<typeof composeServiceNetwork>;

const composeId = v.id("compose");

// Unsaved randomize / isolated deployment settings a convert preview renders
// with instead of the saved ones.
export const composePreviewOverrides = v.object({
	randomize: v.optional(v.boolean()),
	suffix: v.optional(v.string()),
	isolatedDeployment: v.optional(v.boolean()),
});

export const composeJobSpecs = [
	v.object({
		kind: v.literal("compose.deploy"),
		composeId,
		freshVolumes: v.optional(v.boolean()),
		// Host-level compose settings (privileged, host namespaces, host
		// binds, raw Traefik rules, any docker command) are honoured only
		// when set; see isTrustedJob in lib/hostPolicy.ts.
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("compose.redeploy"),
		composeId,
		freshVolumes: v.optional(v.boolean()),
		trusted: v.optional(v.boolean()),
	}),
	v.object({ kind: v.literal("compose.start"), composeId }),
	v.object({ kind: v.literal("compose.stop"), composeId }),
	// The compose row is already gone when this runs, so it carries what
	// teardown needs.
	v.object({
		kind: v.literal("compose.remove"),
		appName: v.string(),
		composeType,
		deleteVolumes: v.boolean(),
	}),
	// Resolves the compose file (cloning when `fetch` or nothing is on disk)
	// and reports its service names, or the fully converted file.
	v.object({
		kind: v.literal("compose.loadServices"),
		composeId,
		opId: v.id("composeOps"),
		fetch: v.boolean(),
	}),
	v.object({
		kind: v.literal("compose.convert"),
		composeId,
		opId: v.id("composeOps"),
		fetch: v.boolean(),
		overrides: v.optional(composePreviewOverrides),
	}),
	// The volumes of a running service's
	// container, reported into the op.
	v.object({
		kind: v.literal("compose.loadMounts"),
		composeId,
		opId: v.id("composeOps"),
		serviceName: v.string(),
	}),
	// Clones the git source (op "tree") or reads one file (op "read") so the
	// UI can create patches.
	v.object({
		kind: v.literal("compose.patchRepo"),
		composeId,
		opId: v.id("composeOps"),
		op: v.union(v.literal("tree"), v.literal("read")),
		path: v.optional(v.string()),
	}),
	v.object({
		kind: v.literal("compose.transfer"),
		composeId,
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.boolean(),
	}),
] as const;

export const composeTables = {
	compose: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
		serverId: v.optional(v.id("servers")),
		name: v.string(),
		// Docker compose project / stack name and directory under
		// /etc/panara-cloud/compose. Immutable after creation.
		appName: v.string(),
		description: v.optional(v.string()),
		// A URL (template logo) or an image data URL picked in the UI.
		icon: v.optional(v.string()),
		composeType,
		// "raw": the compose file lives in `composeFiles`; "git": it is read
		// from `composePath` inside the cloned `gitSource`.
		sourceType: v.union(v.literal("raw"), v.literal("git")),
		gitSource: v.optional(gitSource),
		// Denormalized from gitSource for webhook fan-out.
		gitProviderId: v.optional(v.id("gitProviders")),
		composePath: v.string(),
		// Replaces the generated `docker compose ... up` command (without the
		// leading `docker`).
		command: v.string(),
		createEnvFile: v.boolean(),
		randomize: v.boolean(),
		suffix: v.string(),
		isolatedDeployment: v.boolean(),
		isolatedDeploymentsVolume: v.boolean(),
		pullImages: v.boolean(),
		serviceNetworks: v.optional(v.array(composeServiceNetwork)),
		autoDeploy: v.boolean(),
		triggerType: composeTriggerType,
		// Authenticates POST /api/deploy/compose/<refreshToken>. Only returned
		// to admins.
		refreshToken: v.string(),
		// Who last changed what a deploy runs (file, source, settings, env,
		// mounts, webhook token). Deploys without a requester (webhooks, git
		// pushes) are trusted only while this is an instance administrator;
		// see composeJobTrusted in compose/lib.ts.
		configuredBy: v.optional(v.string()),
		status: composeStatus,
		// Service names of the last resolved compose file (load services or
		// deploy), for the domain service picker.
		services: v.optional(v.array(v.string())),
		servicesLoadedAt: v.optional(v.number()),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_environmentId", ["environmentId"])
		.index("by_appName", ["appName"])
		.index("by_refreshToken", ["refreshToken"])
		.index("by_gitProviderId", ["gitProviderId"])
		.index("by_serverId", ["serverId"]),

	// Raw compose files, apart from `compose` so list queries never load them.
	composeFiles: defineTable({
		organizationId: v.string(),
		composeId,
		content: v.string(),
	}).index("by_composeId", ["composeId"]),

	// Results of load-services / convert jobs. Converted files can be large,
	// so they live here rather than on the compose row. Garbage-collected.
	composeOps: defineTable({
		organizationId: v.string(),
		composeId,
		kind: v.union(
			v.literal("loadServices"),
			v.literal("convert"),
			v.literal("mounts"),
			v.literal("patchRepo"),
		),
		jobId: v.optional(v.id("jobs")),
		result: v.optional(v.string()),
		error: v.optional(v.string()),
		completedAt: v.optional(v.number()),
	})
		.index("by_composeId", ["composeId"])
		.index("by_jobId", ["jobId"]),
};
