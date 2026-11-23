import { defineTable } from "convex/server";
import { type Validator, v } from "convex/values";

export const LOCAL_PARTITION = "local";

export const memberRole = v.union(
	v.literal("owner"),
	v.literal("admin"),
	v.literal("member"),
);

export const coreJobSpecs = [
	v.object({
		kind: v.literal("server.validate"),
		serverId: v.id("servers"),
	}),
	v.object({
		kind: v.literal("noop"),
		message: v.string(),
	}),
] as const;

export const jobStatus = v.union(
	v.literal("queued"),
	v.literal("running"),
	v.literal("succeeded"),
	v.literal("failed"),
	v.literal("cancelled"),
);

// Secret kinds are namespaced strings owned by each domain, e.g.
// "sshPrivateKey", "application.env", "registry.password".
export const secretKind = v.string();

export const coreTables = {
	// Accounts whose current email address nobody proved: created with
	// initial credentials by an organization admin (vouchedBy), changed on
	// an instance without email, or handed over through an admin's reset
	// link. Their invitations from other organizations aren't listed to
	// them; only the invitation link joins (see auth.ts).
	unprovenEmails: defineTable({
		userId: v.string(),
		email: v.string(),
		vouchedBy: v.optional(v.string()),
	}).index("by_userId", ["userId"]),
	// Mirror of the Better Auth `member` table, kept in sync by triggers in
	// auth.ts so access checks are a single indexed read in the app.
	memberships: defineTable({
		memberId: v.string(),
		organizationId: v.string(),
		userId: v.string(),
		role: memberRole,
		// Copied from the Better Auth user's `banned` flag so every access
		// check refuses a deactivated account without another read.
		deactivated: v.optional(v.boolean()),
		// The organization a new session opens in (the default org).
		isDefault: v.optional(v.boolean()),
	})
		.index("by_memberId", ["memberId"])
		.index("by_organizationId_and_userId", ["organizationId", "userId"])
		.index("by_userId", ["userId"]),

	// Per-member grants (the "Add permissions" dialog). Only read
	// for the member role; owners and admins hold every permission. Ids are
	// strings because accessed services span several tables.
	memberGrants: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		accessedProjects: v.array(v.string()),
		accessedEnvironments: v.array(v.string()),
		accessedServices: v.array(v.string()),
		canCreateProjects: v.boolean(),
		canDeleteProjects: v.boolean(),
		canCreateServices: v.boolean(),
		canDeleteServices: v.boolean(),
		canCreateEnvironments: v.boolean(),
		canDeleteEnvironments: v.boolean(),
		canAccessToTraefikFiles: v.boolean(),
		canAccessToDocker: v.boolean(),
		canAccessToAPI: v.boolean(),
		canAccessToSSHKeys: v.boolean(),
		canAccessToGitProviders: v.boolean(),
	}).index("by_organizationId_and_userId", ["organizationId", "userId"]),
	// Uploaded avatars live in file storage; the user record only holds the
	// served URL.
	userAvatars: defineTable({
		userId: v.string(),
		storageId: v.id("_storage"),
	}).index("by_userId", ["userId"]),

	// An uploaded organization logo lives in file storage; the organization
	// record only holds the served URL.
	organizationLogos: defineTable({
		organizationId: v.string(),
		storageId: v.id("_storage"),
	}).index("by_organizationId", ["organizationId"]),

	// Upload URLs handed out per user and purpose, and the files claimed with
	// them: a storage id is only accepted from the user it was uploaded for.
	uploadGrants: defineTable({
		userId: v.string(),
		purpose: v.string(),
		issuedAt: v.number(),
	}).index("by_userId_and_purpose_and_issuedAt", [
		"userId",
		"purpose",
		"issuedAt",
	]),
	uploadClaims: defineTable({
		storageId: v.id("_storage"),
		userId: v.string(),
		purpose: v.string(),
	}).index("by_storageId", ["storageId"]),

	instanceSettings: defineTable({
		key: v.literal("instance"),
		localBuildsConcurrency: v.number(),
	}).index("by_key", ["key"]),

	// Data migrations the installer has applied (convex/install.ts).
	installMigrations: defineTable({
		name: v.string(),
		appliedAt: v.number(),
	}).index("by_name", ["name"]),

	projects: defineTable({
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
	}).index("by_organizationId", ["organizationId"]),

	environments: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		name: v.string(),
		description: v.optional(v.string()),
		isDefault: v.boolean(),
	})
		.index("by_projectId", ["projectId"])
		.index("by_projectId_and_name", ["projectId", "name"]),

	sshKeys: defineTable({
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		publicKey: v.string(),
		lastUsedAt: v.optional(v.number()),
	}).index("by_organizationId", ["organizationId"]),

	// Ciphertext only (AES-256-GCM, key in the SECRETS_KEY env var). Never read
	// by list queries; only internal and agent functions decrypt.
	secrets: defineTable({
		organizationId: v.string(),
		kind: secretKind,
		ownerId: v.string(),
		iv: v.string(),
		ciphertext: v.string(),
	})
		.index("by_kind_and_ownerId", ["kind", "ownerId"])
		.index("by_organizationId", ["organizationId"]),

	servers: defineTable({
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		ipAddress: v.string(),
		port: v.number(),
		username: v.string(),
		sshKeyId: v.optional(v.id("sshKeys")),
		serverType: v.union(v.literal("deploy"), v.literal("build")),
		buildsConcurrency: v.number(),
		enableDockerCleanup: v.boolean(),
		// Server status; absent means active. Inactive servers keep
		// their services but take no new jobs from the server settings.
		serverStatus: v.optional(
			v.union(v.literal("active"), v.literal("inactive")),
		),
		// OpenSSH SHA256 fingerprint of the server's host key, trusted on first
		// use by the agent and verified on every connection after that.
		sshHostKey: v.optional(v.string()),
		lastValidation: v.optional(
			v.object({
				ok: v.boolean(),
				checkedAt: v.number(),
				details: v.string(),
			}),
		),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_sshKeyId", ["sshKeyId"]),

	agents: defineTable({
		name: v.string(),
		secretHash: v.string(),
		disabled: v.boolean(),
	}),

	// High-churn presence lives apart from `agents` so heartbeats don't
	// invalidate subscribers of the agent list.
	agentPresence: defineTable({
		agentId: v.id("agents"),
		lastSeenAt: v.number(),
		version: v.string(),
		capabilities: v.array(v.string()),
	}).index("by_agentId", ["agentId"]),

	// One row per deploy-like operation (deploy, rebuild, rollback, setup, backup).
	// The job carries status and logs; this carries what was deployed.
	deployments: defineTable({
		organizationId: v.string(),
		jobId: v.id("jobs"),
		target: v.object({ kind: v.string(), id: v.string() }),
		title: v.string(),
		description: v.optional(v.string()),
		commit: v.optional(
			v.object({ sha: v.string(), message: v.optional(v.string()) }),
		),
		imageRef: v.optional(v.string()),
	})
		.index("by_jobId", ["jobId"])
		.index("by_target", ["target.kind", "target.id"])
		.index("by_organizationId_and_targetKind", [
			"organizationId",
			"target.kind",
		])
		.index("by_organizationId", ["organizationId"]),

	mounts: defineTable(
		v.union(
			v.object({
				organizationId: v.string(),
				owner: v.object({ kind: v.string(), id: v.string() }),
				type: v.literal("bind"),
				hostPath: v.string(),
				mountPath: v.string(),
			}),
			v.object({
				organizationId: v.string(),
				owner: v.object({ kind: v.string(), id: v.string() }),
				type: v.literal("volume"),
				volumeName: v.string(),
				mountPath: v.string(),
			}),
			v.object({
				organizationId: v.string(),
				owner: v.object({ kind: v.string(), id: v.string() }),
				type: v.literal("file"),
				filePath: v.string(),
				content: v.string(),
				mountPath: v.string(),
			}),
		),
	)
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_organizationId_and_volumeName", ["organizationId", "volumeName"])
		.index("by_volumeName", ["volumeName"]),

	// Leases are separate documents so heartbeats don't rewrite the job row
	// that the UI subscribes to.
	jobLeases: defineTable({
		jobId: v.id("jobs"),
		agentId: v.id("agents"),
		leaseId: v.string(),
		expiresAt: v.number(),
	})
		.index("by_jobId", ["jobId"])
		.index("by_expiresAt", ["expiresAt"]),

	jobLogChunks: defineTable({
		jobId: v.id("jobs"),
		seq: v.number(),
		text: v.string(),
	}).index("by_jobId_and_seq", ["jobId", "seq"]),

	// How far a housekeeping sweep (`jobRetention.ts`) has walked its table, as
	// the `_creationTime` of the last row it looked at.
	housekeepingCursors: defineTable({
		name: v.string(),
		position: v.number(),
	}).index("by_name", ["name"]),
};

export const volumeRemoval = v.object({
	removed: v.array(v.string()),
	kept: v.array(v.object({ name: v.string(), reason: v.string() })),
});

// Volumes of the service the panel already knows something else uses: not
// sent for removal, only reported with the rest of the job's outcome.
export const keptVolumes = v.optional(volumeRemoval.fields.kept);

// Other services deleted in the same action, by appName: a volume they still
// hold is waited for instead of being reported as kept at once.
export const deletingTogether = v.optional(v.array(v.string()));

export const makeJobsTable = <Spec extends Validator<any, "required", any>>(
	spec: Spec,
) =>
	defineTable({
		organizationId: v.string(),
		// Server the job runs against; LOCAL_PARTITION for the panel host.
		partition: v.string(),
		// Jobs in the same group (same service) never run concurrently.
		group: v.string(),
		spec,
		status: jobStatus,
		attempts: v.number(),
		maxAttempts: v.number(),
		// Only idempotent jobs are requeued when their lease expires.
		idempotent: v.boolean(),
		// Builds and deploys occupy one of the server's build slots
		// (buildsConcurrency); quick operational jobs don't wait for them.
		usesBuildSlot: v.optional(v.boolean()),
		cancelRequested: v.boolean(),
		requestedBy: v.optional(v.string()),
		idempotencyKey: v.optional(v.string()),
		claimedBy: v.optional(v.id("agents")),
		startedAt: v.optional(v.number()),
		finishedAt: v.optional(v.number()),
		error: v.optional(v.string()),
		// What a removal with "Also delete volumes" did with each volume.
		volumeRemoval: v.optional(volumeRemoval),
	})
		.index("by_status", ["status"])
		.index("by_partition_and_status", ["partition", "status"])
		.index("by_group", ["group"])
		.index("by_group_and_status", ["group", "status"])
		.index("by_group_and_kind_and_status", ["group", "spec.kind", "status"])
		.index("by_organizationId", ["organizationId"])
		.index("by_organizationId_and_status", ["organizationId", "status"])
		.index("by_idempotencyKey", ["idempotencyKey"])
		.index("by_claimedBy_and_status", ["claimedBy", "status"]);
