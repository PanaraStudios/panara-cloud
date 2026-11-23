import { defineTable } from "convex/server";
import { v } from "convex/values";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { deletingTogether, keptVolumes } from "./core";

export const databaseEngine = v.union(
	v.literal("postgres"),
	v.literal("mysql"),
	v.literal("mariadb"),
	v.literal("mongo"),
	v.literal("redis"),
	v.literal("libsql"),
);

// Engines with logical (dump-based) backups; redis only has volume backups.
export const backupEngine = v.union(
	v.literal("postgres"),
	v.literal("mysql"),
	v.literal("mariadb"),
	v.literal("mongo"),
	v.literal("libsql"),
);

export const databaseStatus = v.union(
	v.literal("idle"),
	v.literal("running"),
	v.literal("done"),
	v.literal("error"),
);

// A database backup reads either one of our databases or a database service
// inside a compose project (owned by the compose domain, resolved by id).
export const backupOwner = v.object({
	kind: v.union(v.literal("database"), v.literal("compose")),
	id: v.string(),
});

export const volumeOwner = v.object({
	kind: v.union(
		v.literal("application"),
		v.literal("compose"),
		v.literal("database"),
	),
	id: v.string(),
});

export const destinationFields = {
	name: v.string(),
	provider: v.optional(v.string()),
	accessKey: v.string(),
	bucket: v.string(),
	region: v.string(),
	endpoint: v.string(),
	additionalFlags: v.array(v.string()),
};

const destinationDraft = v.object({
	provider: v.optional(v.string()),
	accessKey: v.string(),
	bucket: v.string(),
	region: v.string(),
	endpoint: v.string(),
	additionalFlags: v.array(v.string()),
});

const scheduleState = {
	cronExpression: v.string(),
	timezone: v.optional(v.string()),
	enabled: v.boolean(),
	nextRunAt: v.optional(v.number()),
	scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
	// Bumped on every reschedule so a stale scheduled run becomes a no-op.
	generation: v.number(),
};

export const databasesJobSpecs = [
	// `trusted`: bind mounts outside the service's folder are applied only
	// when set; see isTrustedJob in lib/hostPolicy.ts.
	v.object({
		kind: v.literal("databases.deploy"),
		databaseId: v.id("databases"),
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("databases.start"),
		databaseId: v.id("databases"),
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("databases.stop"),
		databaseId: v.id("databases"),
	}),
	v.object({
		kind: v.literal("databases.reload"),
		databaseId: v.id("databases"),
		trusted: v.optional(v.boolean()),
	}),
	v.object({
		kind: v.literal("databases.rebuild"),
		databaseId: v.id("databases"),
		trusted: v.optional(v.boolean()),
	}),
	// The row is already gone when this runs, so it carries the names.
	v.object({
		kind: v.literal("databases.remove"),
		appName: v.string(),
		volumeNames: v.array(v.string()),
		keptVolumes,
		deletingTogether,
	}),
	v.object({
		kind: v.literal("databases.backupRun"),
		backupId: v.id("databaseBackups"),
	}),
	v.object({
		kind: v.literal("databases.restore"),
		owner: backupOwner,
		// Compose restores take credentials from this backup's settings, or
		// (the restore form) from `serviceName` + `databaseUser` and the
		// password in `secrets` (kind "databases.restorePassword", ownerId: the
		// job id).
		backupId: v.optional(v.id("databaseBackups")),
		serviceName: v.optional(v.string()),
		databaseUser: v.optional(v.string()),
		destinationId: v.id("destinations"),
		backupFile: v.string(),
		databaseName: v.string(),
		databaseType: backupEngine,
	}),
	v.object({
		kind: v.literal("databases.volumeBackupRun"),
		volumeBackupId: v.id("volumeBackups"),
	}),
	v.object({
		kind: v.literal("databases.volumeRestore"),
		owner: volumeOwner,
		serviceName: v.optional(v.string()),
		destinationId: v.id("destinations"),
		volumeName: v.string(),
		backupFile: v.string(),
	}),
	v.object({
		kind: v.literal("databases.testDestination"),
		opId: v.id("databaseOps"),
	}),
	v.object({
		kind: v.literal("databases.listBackupFiles"),
		opId: v.id("databaseOps"),
	}),
	v.object({
		kind: v.literal("databases.transfer"),
		databaseId: v.id("databases"),
		targetServerId: v.optional(v.id("servers")),
		removeSourceData: v.boolean(),
	}),
	// Runs ALTER USER (or the engine's equivalent) in the running container
	// with the new password, which waits encrypted in `secrets` (kind
	// "databases.pendingPassword", ownerId: the job id) until it succeeds.
	v.object({
		kind: v.literal("databases.changePassword"),
		databaseId: v.id("databases"),
		user: v.union(v.literal("user"), v.literal("root")),
	}),
	v.object({
		kind: v.literal("databases.panelBackupRun"),
		panelBackupId: v.id("panelBackups"),
	}),
	v.object({
		kind: v.literal("databases.panelRestore"),
		destinationId: v.id("destinations"),
		backupFile: v.string(),
	}),
] as const;

export const databasesTables = {
	// All six engines share one table: they have the same service settings,
	// lifecycle and jobs, so one index set and one authz path serve them all.
	// Engine-specific fields are optional and validated per engine on write.
	// Passwords and env live in `secrets` (kinds "databases.password",
	// "databases.rootPassword", "databases.env"; ownerId: this row's id).
	databases: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		environmentId: v.id("environments"),
		serverId: v.optional(v.id("servers")),
		engine: databaseEngine,
		name: v.string(),
		appName: v.string(),
		description: v.optional(v.string()),
		dockerImage: v.string(),
		databaseName: v.optional(v.string()),
		databaseUser: v.optional(v.string()),
		command: v.optional(v.string()),
		args: v.optional(v.array(v.string())),
		replicas: v.number(),
		externalPort: v.optional(v.number()),
		externalGRPCPort: v.optional(v.number()),
		externalAdminPort: v.optional(v.number()),
		replicaSets: v.optional(v.boolean()),
		sqldNode: v.optional(v.union(v.literal("primary"), v.literal("replica"))),
		sqldPrimaryUrl: v.optional(v.string()),
		enableNamespaces: v.optional(v.boolean()),
		status: databaseStatus,
		// What the service was before the deploy that set "running", so a
		// cancelled deploy can put it back (lib/serviceStatus.ts).
		statusBeforeDeploy: v.optional(databaseStatus),
		// Extra overlay networks on the database's server and whether it leaves
		// panara-cloud-network; ignored when networkSwarm is set.
		networkIds: v.optional(v.array(v.id("networks"))),
		detachPanaraCloudNetwork: v.optional(v.boolean()),
		...swarmSettings,
		...resourceSettings,
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_environmentId", ["environmentId"])
		.index("by_projectId", ["projectId"])
		.index("by_serverId", ["serverId"])
		.index("by_appName", ["appName"]),

	// S3-compatible backup targets. The secret access key is stored encrypted
	// (kind "databases.destinationSecret", ownerId: this row's id).
	destinations: defineTable({
		organizationId: v.string(),
		...destinationFields,
	}).index("by_organizationId", ["organizationId"]),

	databaseBackups: defineTable({
		organizationId: v.string(),
		owner: backupOwner,
		// Compose owners only: the service in the compose file.
		serviceName: v.optional(v.string()),
		databaseType: backupEngine,
		database: v.string(),
		destinationId: v.id("destinations"),
		prefix: v.string(),
		customName: v.optional(v.string()),
		keepLatestCount: v.optional(v.number()),
		// Compose owners only (our databases carry their own credentials): the
		// database user. The password is in `secrets` (kind
		// "databases.backupPassword", ownerId: this row's id).
		databaseUser: v.optional(v.string()),
		...scheduleState,
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_destinationId", ["destinationId"])
		.index("by_enabled", ["enabled"]),

	volumeBackups: defineTable({
		organizationId: v.string(),
		name: v.string(),
		owner: volumeOwner,
		serviceName: v.optional(v.string()),
		volumeName: v.string(),
		prefix: v.string(),
		// Stop the service while the volume is archived.
		turnOff: v.boolean(),
		keepLatestCount: v.optional(v.number()),
		destinationId: v.id("destinations"),
		...scheduleState,
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_destinationId", ["destinationId"])
		.index("by_enabled", ["enabled"]),

	// Backups of the panel host (web-server backups): a Convex
	// snapshot export plus /etc/panara-cloud, archived to a destination of the
	// instance's root organization. Managed by instance administrators.
	panelBackups: defineTable({
		organizationId: v.string(),
		destinationId: v.id("destinations"),
		prefix: v.string(),
		keepLatestCount: v.optional(v.number()),
		// When set, the archive carries the
		// deployment secrets (SECRETS_KEY, auth secret, agent JWT keys) so a new
		// panel can use the snapshot.
		includeEncryptionKey: v.optional(v.boolean()),
		...scheduleState,
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_destinationId", ["destinationId"])
		.index("by_enabled", ["enabled"]),

	// One-off agent operations whose result the UI waits for (bucket listing,
	// connection tests). A draft test's secret key is stored encrypted with
	// kind "databases.destinationDraft", ownerId: this row's id, and deleted
	// when the job reports.
	databaseOps: defineTable({
		organizationId: v.string(),
		jobId: v.optional(v.id("jobs")),
		request: v.union(
			v.object({
				kind: v.literal("testDestination"),
				destinationId: v.optional(v.id("destinations")),
				draft: v.optional(destinationDraft),
			}),
			v.object({
				kind: v.literal("listBackupFiles"),
				destinationId: v.id("destinations"),
				path: v.string(),
				search: v.optional(v.string()),
				include: v.optional(v.string()),
			}),
		),
		done: v.boolean(),
		result: v.optional(v.string()),
		error: v.optional(v.string()),
	}).index("by_jobId", ["jobId"]),
};
