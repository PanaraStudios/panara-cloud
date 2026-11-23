import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { resolveServiceNetworks } from "../infra/networks";
import {
	cancelQueuedServiceJobs,
	hostName,
	splitNetworks,
} from "../infra/transfer";
import { loadSharedEnv } from "../lib/env";
import { enqueueJob } from "../lib/jobs";
import { requireLease } from "../lib/lease";
import { listMounts } from "../lib/mounts";
import { deleteSecret, putSecret, readSecret } from "../lib/secrets";
import { reportedStatus } from "../lib/serviceStatus";
import { resolveHostTarget } from "../lib/targets";
import { dispatchNotification } from "../platform/notifications";
import {
	BACKUP_PASSWORD_KIND,
	backupFolder,
	DESTINATION_DRAFT_KIND,
	DESTINATION_SECRET_KIND,
	ENGINES,
	ENV_KIND,
	groupFor,
	PASSWORD_KIND,
	PENDING_PASSWORD_KIND,
	partitionOf,
	projectNameOf,
	RESTORE_PASSWORD_KIND,
	type ResolvedOwner,
	ROOT_PASSWORD_KIND,
	resolveOwner,
} from "./lib";
import { panelBackupFolder } from "./panelBackups";

const leaseArgs = { jobId: v.id("jobs"), leaseId: v.string() };
const MAX_OP_RESULT = 512 * 1024;

type Spec = Doc<"jobs">["spec"];
type SpecOf<K extends Spec["kind"]> = Extract<Spec, { kind: K }>;

const specOf = <K extends Spec["kind"]>(
	job: Doc<"jobs">,
	...kinds: K[]
): SpecOf<K> => {
	if (!kinds.includes(job.spec.kind as K)) {
		throw new ConvexError(`Not a ${kinds.join("/")} job`);
	}
	return job.spec as SpecOf<K>;
};

const loadJobDatabase = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	databaseId: Id<"databases">,
) => {
	const database = await ctx.db.get("databases", databaseId);
	if (!database || database.organizationId !== job.organizationId) {
		throw new ConvexError("Database not found");
	}
	return database;
};

const destinationSnapshot = async (
	ctx: QueryCtx,
	organizationId: string,
	destinationId: Id<"destinations">,
) => {
	const destination = await ctx.db.get("destinations", destinationId);
	if (!destination || destination.organizationId !== organizationId) {
		throw new ConvexError("Destination not found");
	}
	const secretAccessKey = await readSecret(
		ctx,
		DESTINATION_SECRET_KIND,
		destinationId,
	);
	if (secretAccessKey === null) {
		throw new ConvexError("Destination secret key is missing");
	}
	return {
		provider: destination.provider,
		accessKey: destination.accessKey,
		secretAccessKey,
		bucket: destination.bucket,
		region: destination.region,
		endpoint: destination.endpoint,
		additionalFlags: destination.additionalFlags,
	};
};

const ownerOf = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	owner: Parameters<typeof resolveOwner>[1],
): Promise<ResolvedOwner> => {
	const resolved = await resolveOwner(ctx, owner);
	if (!resolved || resolved.organizationId !== job.organizationId) {
		throw new ConvexError("Service not found");
	}
	return resolved;
};

const credentialsOf = async (ctx: QueryCtx, database: Doc<"databases">) => ({
	databaseName: database.databaseName,
	databaseUser: database.databaseUser,
	password: (await readSecret(ctx, PASSWORD_KIND, database._id)) ?? "",
	rootPassword: ENGINES[database.engine].hasRootPassword
		? ((await readSecret(ctx, ROOT_PASSWORD_KIND, database._id)) ?? "")
		: undefined,
});

// Snapshot for databases.deploy/start/stop/reload/rebuild. Only deploy and
// rebuild get credentials and env; the others just need the service name.
export const getServiceContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(
			job,
			"databases.deploy",
			"databases.start",
			"databases.stop",
			"databases.reload",
			"databases.rebuild",
		);
		const database = await loadJobDatabase(ctx, job, spec.databaseId);
		const base = {
			databaseId: database._id,
			engine: database.engine,
			appName: database.appName,
			name: database.name,
			replicas: database.replicas,
		};
		if (spec.kind !== "databases.deploy" && spec.kind !== "databases.rebuild") {
			return { ...base, deploy: null };
		}
		const {
			_id,
			_creationTime,
			status: _status,
			networkIds: _networkIds,
			detachPanaraCloudNetwork: _detach,
			...settings
		} = database;
		const networkSwarm = await resolveServiceNetworks(ctx, database);
		const shared = await loadSharedEnv(ctx, database.environmentId);
		const mounts = await listMounts(ctx, { kind: "database", id: _id });
		return {
			...base,
			deploy: {
				...settings,
				...(networkSwarm ? { networkSwarm } : {}),
				databaseId: _id,
				env: (await readSecret(ctx, ENV_KIND, _id)) ?? "",
				projectEnv: shared.projectEnv,
				environmentEnv: shared.environmentEnv,
				credentials: await credentialsOf(ctx, database),
				mounts: mounts.map(
					({
						_id: _m,
						_creationTime: _c,
						organizationId: _o,
						owner: _w,
						...m
					}) => m,
				),
			},
		};
	},
});

export const reportStatus = mutation({
	args: {
		...leaseArgs,
		status: v.union(
			v.literal("idle"),
			v.literal("running"),
			v.literal("done"),
			v.literal("error"),
		),
		despiteCancel: v.optional(v.boolean()),
	},
	handler: async (ctx, { jobId, leaseId, status, despiteCancel }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(
			job,
			"databases.deploy",
			"databases.start",
			"databases.stop",
			"databases.reload",
			"databases.rebuild",
		);
		const database = await ctx.db.get("databases", spec.databaseId);
		if (database && database.organizationId === job.organizationId) {
			await ctx.db.patch(
				"databases",
				database._id,
				reportedStatus(job, database, status, despiteCancel),
			);
		}
	},
});

const containerTarget = (resolved: ResolvedOwner, serviceName?: string) =>
	serviceName && resolved.composeType
		? {
				kind: "compose" as const,
				appName: resolved.appName,
				serviceName,
				composeType: resolved.composeType,
			}
		: { kind: "swarm" as const, appName: resolved.appName };

// Snapshot for databases.backupRun: what to dump, with which credentials, and
// where in the destination to upload it.
export const getBackupContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.backupRun");
		const backup = await ctx.db.get("databaseBackups", spec.backupId);
		if (!backup || backup.organizationId !== job.organizationId) {
			throw new ConvexError("Backup not found");
		}
		const resolved = await ownerOf(ctx, job, backup.owner);
		let credentials: {
			databaseUser?: string;
			password: string;
			rootPassword?: string;
		};
		if (backup.owner.kind === "database") {
			const database = await loadJobDatabase(
				ctx,
				job,
				backup.owner.id as Id<"databases">,
			);
			credentials = await credentialsOf(ctx, database);
		} else {
			const password =
				(await readSecret(ctx, BACKUP_PASSWORD_KIND, backup._id)) ?? "";
			credentials = {
				databaseUser: backup.databaseUser,
				password,
				rootPassword: backup.databaseType === "mysql" ? password : undefined,
			};
		}
		return {
			backupId: backup._id,
			databaseType: backup.databaseType,
			database: backup.database,
			customName: backup.customName,
			keepLatestCount: backup.keepLatestCount,
			folder: backupFolder(resolved.appName, backup.serviceName, backup.prefix),
			target: containerTarget(resolved, backup.serviceName),
			credentials,
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				backup.destinationId,
			),
		};
	},
});

const backupStatus = v.union(v.literal("success"), v.literal("error"));

// Records the outcome and sends the databaseBackup notification.
export const reportBackup = mutation({
	args: {
		...leaseArgs,
		status: backupStatus,
		error: v.optional(v.string()),
		file: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, status, error, file }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.backupRun");
		const backup = await ctx.db.get("databaseBackups", spec.backupId);
		if (!backup) return;
		const resolved = await resolveOwner(ctx, backup.owner);
		if (file) {
			const deployment = await ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique();
			if (deployment) {
				await ctx.db.patch("deployments", deployment._id, {
					description: file,
				});
			}
		}
		await dispatchNotification(ctx, {
			organizationId: job.organizationId,
			event: {
				type: "databaseBackup",
				projectName: await projectNameOf(ctx, resolved?.environmentId),
				applicationName: resolved?.name ?? backup.database,
				databaseType:
					backup.databaseType === "mongo" ? "mongodb" : backup.databaseType,
				databaseName: backup.database,
				status,
				errorMessage:
					status === "error" ? (error ?? "Unknown error") : undefined,
			},
		});
	},
});

export const getRestoreContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.restore");
		const resolved = await ownerOf(ctx, job, spec.owner);
		let credentials: {
			databaseUser?: string;
			password: string;
			rootPassword?: string;
		};
		let serviceName: string | undefined;
		if (spec.owner.kind === "database") {
			const database = await loadJobDatabase(
				ctx,
				job,
				spec.owner.id as Id<"databases">,
			);
			credentials = await credentialsOf(ctx, database);
		} else if (!spec.backupId && spec.serviceName) {
			serviceName = spec.serviceName;
			const password =
				(await readSecret(ctx, RESTORE_PASSWORD_KIND, jobId)) ?? "";
			credentials = {
				databaseUser: spec.databaseUser,
				password,
				rootPassword: spec.databaseType === "mysql" ? password : undefined,
			};
		} else {
			const backup = spec.backupId
				? await ctx.db.get("databaseBackups", spec.backupId)
				: null;
			if (!backup || backup.organizationId !== job.organizationId) {
				throw new ConvexError("Backup not found");
			}
			serviceName = backup.serviceName;
			const password =
				(await readSecret(ctx, BACKUP_PASSWORD_KIND, backup._id)) ?? "";
			credentials = {
				databaseUser: backup.databaseUser,
				password,
				rootPassword: backup.databaseType === "mysql" ? password : undefined,
			};
		}
		return {
			databaseType: spec.databaseType,
			databaseName: spec.databaseName,
			backupFile: spec.backupFile,
			target: containerTarget(resolved, serviceName),
			credentials,
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				spec.destinationId,
			),
		};
	},
});

// Drops the password typed into a compose restore form once the restore
// ended, whatever its outcome.
export const finishRestore = mutation({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		specOf(job, "databases.restore");
		await deleteSecret(ctx, RESTORE_PASSWORD_KIND, jobId);
	},
});

// How to stop and restart the owner while its volume is archived.
const serviceControl = (resolved: ResolvedOwner, serviceName?: string) => {
	if (resolved.composeType === "docker-compose") {
		return {
			kind: "compose" as const,
			project: resolved.appName,
			serviceName: serviceName ?? "",
		};
	}
	return {
		kind: "swarm" as const,
		serviceName:
			resolved.composeType === "stack" && serviceName
				? `${resolved.appName}_${serviceName}`
				: resolved.appName,
	};
};

export const getVolumeBackupContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.volumeBackupRun");
		const row = await ctx.db.get("volumeBackups", spec.volumeBackupId);
		if (!row || row.organizationId !== job.organizationId) {
			throw new ConvexError("Volume backup not found");
		}
		const resolved = await ownerOf(ctx, job, row.owner);
		return {
			volumeBackupId: row._id,
			volumeName: row.volumeName,
			turnOff: row.turnOff,
			keepLatestCount: row.keepLatestCount,
			folder: backupFolder(resolved.appName, row.serviceName, row.prefix),
			service: serviceControl(resolved, row.serviceName),
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				row.destinationId,
			),
		};
	},
});

export const reportVolumeBackup = mutation({
	args: {
		...leaseArgs,
		status: backupStatus,
		error: v.optional(v.string()),
		file: v.optional(v.string()),
		backupSize: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, status, error, file, backupSize }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.volumeBackupRun");
		const row = await ctx.db.get("volumeBackups", spec.volumeBackupId);
		if (!row) return;
		const resolved = await resolveOwner(ctx, row.owner);
		if (file) {
			const deployment = await ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique();
			if (deployment) {
				await ctx.db.patch("deployments", deployment._id, {
					description: file,
				});
			}
		}
		const serviceType =
			row.owner.kind === "database"
				? resolved?.engine === "mongo"
					? "mongodb"
					: (resolved?.engine ?? "database")
				: row.owner.kind;
		await dispatchNotification(ctx, {
			organizationId: job.organizationId,
			event: {
				type: "volumeBackup",
				projectName: await projectNameOf(ctx, resolved?.environmentId),
				applicationName: row.name,
				volumeName: row.volumeName,
				serviceType,
				status,
				errorMessage:
					status === "error" ? (error ?? "Unknown error") : undefined,
				backupSize,
			},
		});
	},
});

export const getVolumeRestoreContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.volumeRestore");
		const resolved = await ownerOf(ctx, job, spec.owner);
		return {
			appName: resolved.appName,
			volumeName: spec.volumeName,
			backupFile: spec.backupFile,
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				spec.destinationId,
			),
		};
	},
});

const loadOp = async (ctx: QueryCtx, job: Doc<"jobs">) => {
	const spec = specOf(
		job,
		"databases.testDestination",
		"databases.listBackupFiles",
	);
	const op = await ctx.db.get("databaseOps", spec.opId);
	if (!op || op.organizationId !== job.organizationId) {
		throw new ConvexError("Operation not found");
	}
	return op;
};

export const getOpContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const op = await loadOp(ctx, job);
		const request = op.request;
		if (request.kind === "listBackupFiles") {
			return {
				kind: "listBackupFiles" as const,
				path: request.path,
				search: request.search,
				include: request.include,
				destination: await destinationSnapshot(
					ctx,
					job.organizationId,
					request.destinationId,
				),
			};
		}
		if (request.destinationId) {
			return {
				kind: "testDestination" as const,
				destination: await destinationSnapshot(
					ctx,
					job.organizationId,
					request.destinationId,
				),
			};
		}
		if (!request.draft) throw new ConvexError("Nothing to test");
		const secretAccessKey = await readSecret(
			ctx,
			DESTINATION_DRAFT_KIND,
			op._id,
		);
		if (secretAccessKey === null) throw new ConvexError("Draft has expired");
		return {
			kind: "testDestination" as const,
			destination: { ...request.draft, secretAccessKey },
		};
	},
});

export const reportOp = mutation({
	args: {
		...leaseArgs,
		result: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, result, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const op = await loadOp(ctx, job);
		if (result && result.length > MAX_OP_RESULT) {
			throw new ConvexError("Result too large");
		}
		await ctx.db.patch("databaseOps", op._id, {
			done: true,
			result,
			error: error?.slice(0, 4000),
		});
		await deleteSecret(ctx, DESTINATION_DRAFT_KIND, op._id);
	},
});

// Deployment env vars a restored panel needs to read the snapshot: encrypted
// secrets, Better Auth sessions and hashes, the agents' JWT signing keys and
// outgoing email. Non-secret settings (SITE_URL, …) are left to the new host.
export const PANEL_SECRET_ENV = [
	"SECRETS_KEY",
	"BETTER_AUTH_SECRET",
	"AGENT_JWT_PRIVATE_KEY",
	"AGENT_JWT_KID",
	"AGENT_JWKS",
	"RESEND_API_KEY",
] as const;

// Snapshot for databases.panelBackupRun: where the archive goes and how many
// to keep. The Convex admin key never passes through here; the agent reads it
// from its own environment. The deployment secrets do, only when the instance
// admin chose to include them in the backup.
export const getPanelBackupContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.panelBackupRun");
		const backup = await ctx.db.get("panelBackups", spec.panelBackupId);
		if (!backup || backup.organizationId !== job.organizationId) {
			throw new ConvexError("Panel backup not found");
		}
		return {
			panelBackupId: backup._id,
			folder: panelBackupFolder(backup.prefix),
			keepLatestCount: backup.keepLatestCount,
			secrets: backup.includeEncryptionKey
				? PANEL_SECRET_ENV.flatMap((name) => {
						const value = process.env[name];
						return value ? [{ name, value }] : [];
					})
				: [],
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				backup.destinationId,
			),
		};
	},
});

// Records the outcome and sends the instance-wide panelBackup notification.
export const reportPanelBackup = mutation({
	args: {
		...leaseArgs,
		status: backupStatus,
		error: v.optional(v.string()),
		file: v.optional(v.string()),
		backupSize: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, status, error, file, backupSize }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		specOf(job, "databases.panelBackupRun");
		if (file) {
			const deployment = await ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique();
			if (deployment) {
				await ctx.db.patch("deployments", deployment._id, {
					description: file.slice(0, 2000),
				});
			}
		}
		await dispatchNotification(ctx, {
			organizationId: null,
			event: {
				type: "panelBackup",
				status,
				errorMessage:
					status === "error"
						? (error ?? "Unknown error").slice(0, 2000)
						: undefined,
				backupSize,
			},
		});
	},
});

export const getPanelRestoreContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.panelRestore");
		return {
			backupFile: spec.backupFile,
			destination: await destinationSnapshot(
				ctx,
				job.organizationId,
				spec.destinationId,
			),
		};
	},
});

const transferDatabase = async (ctx: QueryCtx, job: Doc<"jobs">) => {
	const spec = specOf(job, "databases.transfer");
	const database = await ctx.db.get("databases", spec.databaseId);
	if (!database || database.organizationId !== job.organizationId) return null;
	return { spec, database };
};

export const getTransferContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferDatabase(ctx, job);
		if (!found) return null;
		const { spec, database } = found;
		if (partitionOf(database.serverId) !== job.partition) {
			throw new ConvexError("The database moved since the transfer was queued");
		}
		const mounts = await listMounts(ctx, {
			kind: "database",
			id: database._id,
		});
		return {
			appName: database.appName,
			replicas: database.replicas,
			removeSourceData: spec.removeSourceData,
			sourceName: await hostName(ctx, database.serverId),
			targetName: await hostName(ctx, spec.targetServerId),
			source: await resolveHostTarget(ctx, database.serverId),
			target: await resolveHostTarget(ctx, spec.targetServerId),
			volumes: [
				...new Set(
					mounts.flatMap((m) => (m.type === "volume" ? [m.volumeName] : [])),
				),
			],
			bindPaths: [
				...new Set(
					mounts.flatMap((m) => (m.type === "bind" ? [m.hostPath] : [])),
				),
			],
		};
	},
});

export const reportTransferStatus = mutation({
	args: {
		...leaseArgs,
		status: v.union(
			v.literal("running"),
			v.literal("error"),
			v.literal("idle"),
		),
	},
	handler: async (ctx, { jobId, leaseId, status }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferDatabase(ctx, job);
		if (found) await ctx.db.patch("databases", found.database._id, { status });
	},
});

// Switches servers and queues the deploy there. Backups follow on their own:
// they resolve the database's server when they run.
export const completeTransfer = mutation({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferDatabase(ctx, job);
		if (!found) return { warnings: [] };
		const { spec, database } = found;
		const targetServerId = spec.targetServerId;
		const warnings: string[] = [];
		const networks = await splitNetworks(
			ctx,
			database.networkIds,
			targetServerId,
		);
		if (networks.dropped.length > 0) {
			warnings.push(
				`Detached networks that don't exist on the target: ${networks.dropped.join(", ")}`,
			);
		}
		const detach =
			database.detachPanaraCloudNetwork && networks.kept.length > 0;
		const group = groupFor(database.engine, database._id);
		await cancelQueuedServiceJobs(ctx, group, jobId, "databases.");
		await ctx.db.patch("databases", database._id, {
			serverId: targetServerId,
			networkIds: networks.kept.length > 0 ? networks.kept : undefined,
			detachPanaraCloudNetwork: detach || undefined,
			status: "idle",
		});
		const deployJobId = await enqueueJob(ctx, {
			organizationId: database.organizationId,
			partition: partitionOf(targetServerId),
			group,
			spec: { kind: "databases.deploy", databaseId: database._id },
			idempotent: true,
			requestedBy: job.requestedBy,
		});
		await ctx.db.insert("deployments", {
			organizationId: database.organizationId,
			jobId: deployJobId,
			target: { kind: "database", id: database._id },
			title: "Deploy after transfer",
			description: `Transferred to ${await hostName(ctx, targetServerId)}`,
			imageRef: database.dockerImage,
		});
		return { warnings };
	},
});

// Current credentials (to authenticate in the container) and the requested
// password.
export const getPasswordChangeContext = query({
	args: leaseArgs,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.changePassword");
		const database = await loadJobDatabase(ctx, job, spec.databaseId);
		const newPassword = await readSecret(ctx, PENDING_PASSWORD_KIND, jobId);
		if (newPassword === null)
			throw new ConvexError("No password change pending");
		return {
			engine: database.engine,
			appName: database.appName,
			user: spec.user,
			credentials: await credentialsOf(ctx, database),
			newPassword,
		};
	},
});

// On success the pending password becomes the stored one. Redis and libsql
// read their password from the service env at start, so they are redeployed
// to keep the change across restarts.
export const reportPasswordChange = mutation({
	args: { ...leaseArgs, ok: v.boolean() },
	handler: async (ctx, { jobId, leaseId, ok }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "databases.changePassword");
		const pending = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", PENDING_PASSWORD_KIND).eq("ownerId", jobId),
			)
			.unique();
		if (!pending) return;
		await ctx.db.delete("secrets", pending._id);
		const database = await ctx.db.get("databases", spec.databaseId);
		if (!ok || !database || database.organizationId !== job.organizationId) {
			return;
		}
		const sealed = { iv: pending.iv, ciphertext: pending.ciphertext };
		const kinds =
			spec.user === "root"
				? [ROOT_PASSWORD_KIND]
				: database.databaseUser === "root" && database.engine === "mysql"
					? [PASSWORD_KIND, ROOT_PASSWORD_KIND]
					: [PASSWORD_KIND];
		for (const kind of kinds) {
			await putSecret(ctx, {
				organizationId: database.organizationId,
				kind,
				ownerId: database._id,
				...sealed,
			});
		}
		if (database.engine === "redis" || database.engine === "libsql") {
			const deployJobId = await enqueueJob(ctx, {
				organizationId: database.organizationId,
				partition: partitionOf(database.serverId),
				group: groupFor(database.engine, database._id),
				spec: { kind: "databases.deploy", databaseId: database._id },
				idempotent: true,
				requestedBy: job.requestedBy,
			});
			await ctx.db.insert("deployments", {
				organizationId: database.organizationId,
				jobId: deployJobId,
				target: { kind: "database", id: database._id },
				title: "Deploy",
				description: "Apply the new password",
				imageRef: database.dockerImage,
			});
		}
	},
});
