import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import { enqueueJob } from "../lib/jobs";
import { type Action, requireServicePermission } from "../lib/permissions";
import { deleteSecret, putSecret } from "../lib/secrets";
import { actorOf, recordOwnerEvent } from "../lib/serviceEvents";
import { nextRunAfter } from "../platform/lib/cron";
import { backupEngine, backupOwner } from "../tables/databases";
import { assertBackupFileAccess } from "./backupAccess";
import {
	BACKUP_PASSWORD_KIND,
	type BackupEngine,
	type BackupOwner,
	backupFolder,
	COMPOSE_SERVICE_REGEX,
	cancelPending,
	hasLiveRun,
	loadDestination,
	partitionOf,
	RESTORE_PASSWORD_KIND,
	type ResolvedOwner,
	recentDeployments,
	requireOwner,
	resolveOwner,
	validateBackupPrefix,
	validateComposeServiceName,
	validateIdentifier,
	validateKeepLatest,
	validatePassword,
	validateSchedule,
} from "./lib";
import { startOp } from "./ops";

const MAX_BACKUPS = 100;
const MAX_RUNS = 50;
const RECENT_RUNS = 5;
const RECONCILE_BATCH = 100;
const REMOVE_BATCH = 100;
const QUEUED_SCAN = 20;
const MAX_BACKUP_FILE = 1024;

export const BACKUP_EXTENSIONS: Record<BackupEngine, string> = {
	postgres: ".sql.gz",
	mysql: ".sql.gz",
	mariadb: ".sql.gz",
	mongo: ".bson.gz",
	libsql: ".sql.gz",
};

const backupFields = {
	databaseType: backupEngine,
	database: v.string(),
	destinationId: v.id("destinations"),
	cronExpression: v.string(),
	timezone: v.optional(v.string()),
	enabled: v.boolean(),
	prefix: v.string(),
	customName: v.optional(v.string()),
	keepLatestCount: v.optional(v.number()),
	serviceName: v.optional(v.string()),
	databaseUser: v.optional(v.string()),
};

type BackupFields = {
	databaseType: BackupEngine;
	database: string;
	cronExpression: string;
	timezone?: string;
	prefix: string;
	customName?: string;
	keepLatestCount?: number;
	serviceName?: string;
	databaseUser?: string;
};

const cleanFields = (
	owner: BackupOwner,
	resolved: ResolvedOwner,
	fields: BackupFields,
) => {
	if (owner.kind === "database") {
		if (resolved.engine === "redis") {
			throw new ConvexError("Redis databases only support volume backups");
		}
		if (resolved.engine !== fields.databaseType) {
			throw new ConvexError("Database type does not match the database");
		}
	} else {
		validateComposeServiceName(fields.serviceName);
	}
	const database = fields.database.trim();
	if (fields.databaseType === "libsql") {
		if (!database || database.includes("/") || database.startsWith(".")) {
			throw new ConvexError("Invalid database name");
		}
	} else {
		validateIdentifier(database, "Database name");
	}
	if (fields.customName && !/^[a-zA-Z0-9._-]*$/.test(fields.customName)) {
		throw new ConvexError(
			"Custom name may only contain letters, digits, '.', '_' and '-'",
		);
	}
	validateBackupPrefix(fields.prefix);
	validateSchedule(fields.cronExpression, fields.timezone);
	validateKeepLatest(fields.keepLatestCount);
	const databaseUser =
		owner.kind === "compose"
			? fields.databaseUser?.trim() || undefined
			: undefined;
	if (databaseUser) validateIdentifier(databaseUser, "Database user");
	return {
		databaseType: fields.databaseType,
		database,
		cronExpression: fields.cronExpression.trim(),
		timezone: fields.timezone?.trim() || undefined,
		prefix: fields.prefix.trim(),
		customName: fields.customName?.trim() || undefined,
		keepLatestCount: fields.keepLatestCount || undefined,
		serviceName:
			owner.kind === "compose" ? fields.serviceName?.trim() : undefined,
		databaseUser,
	};
};

// Cancels any pending run and, when enabled, schedules the next one. The
// generation bump turns any run already in flight into a no-op.
export const rescheduleBackup = async (
	ctx: MutationCtx,
	backup: Doc<"databaseBackups">,
) => {
	await cancelPending(ctx, backup.scheduledFunctionId);
	const generation = backup.generation + 1;
	const next = backup.enabled
		? nextRunAfter(backup.cronExpression, backup.timezone, Date.now())
		: null;
	const scheduledFunctionId =
		next === null
			? undefined
			: await ctx.scheduler.runAt(next, internal.databases.backups.fire, {
					backupId: backup._id,
					generation,
				});
	await ctx.db.patch("databaseBackups", backup._id, {
		generation,
		nextRunAt: next ?? undefined,
		scheduledFunctionId,
	});
};

const requireBackupPermission = async (
	ctx: QueryCtx,
	backup: Doc<"databaseBackups">,
	action: Action<"backup">,
) =>
	await requireServicePermission(
		ctx,
		{ _id: backup.owner.id, organizationId: backup.organizationId },
		"backup",
		action,
	);

const loadBackup = async (
	ctx: QueryCtx,
	backupId: Id<"databaseBackups">,
	action: Action<"backup">,
) => {
	const backup = await ctx.db.get("databaseBackups", backupId);
	if (!backup) throw new ConvexError("Backup not found");
	const { userId } = await requireBackupPermission(ctx, backup, action);
	return { backup, userId };
};

const enqueueRun = async (
	ctx: MutationCtx,
	backup: Doc<"databaseBackups">,
	resolved: ResolvedOwner,
	requestedBy?: string,
): Promise<Id<"jobs"> | null> => {
	// Don't pile scheduled runs up behind one that hasn't started yet.
	if (!requestedBy) {
		const queued = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", resolved.group).eq("status", "queued"),
			)
			.take(QUEUED_SCAN);
		if (
			queued.some(
				(job) =>
					job.spec.kind === "databases.backupRun" &&
					job.spec.backupId === backup._id,
			)
		) {
			return null;
		}
	}
	const jobId = await enqueueJob(ctx, {
		organizationId: backup.organizationId,
		partition: partitionOf(resolved.serverId),
		// The owner's group: a backup never overlaps a rebuild or restore.
		group: resolved.group,
		spec: { kind: "databases.backupRun", backupId: backup._id },
		idempotent: false,
		requestedBy,
	});
	await ctx.db.insert("deployments", {
		organizationId: backup.organizationId,
		jobId,
		target: { kind: "databaseBackup", id: backup._id },
		title: "Database backup",
		description: requestedBy ? "Manual backup" : "Scheduled backup",
	});
	return jobId;
};

export const create = mutation({
	args: { owner: backupOwner, ...backupFields },
	handler: async (ctx, { owner, destinationId, enabled, ...fields }) => {
		const { resolved } = await requireOwner(ctx, owner, "backup", "create");
		await loadDestination(ctx, resolved.organizationId, destinationId);
		const backupId = await ctx.db.insert("databaseBackups", {
			organizationId: resolved.organizationId,
			owner,
			destinationId,
			enabled,
			...cleanFields(owner, resolved, fields),
			generation: 0,
		});
		const backup = await ctx.db.get("databaseBackups", backupId);
		if (backup) await rescheduleBackup(ctx, backup);
		await recordOwnerEvent(
			ctx,
			owner,
			resolved.organizationId,
			"config.backups",
			await actorOf(ctx),
			{ action: "create" },
		);
		return backupId;
	},
});

export const update = mutation({
	args: { backupId: v.id("databaseBackups"), ...backupFields },
	handler: async (ctx, { backupId, destinationId, enabled, ...fields }) => {
		const { backup } = await loadBackup(ctx, backupId, "update");
		const resolved = await resolveOwner(ctx, backup.owner);
		if (!resolved || resolved.organizationId !== backup.organizationId) {
			throw new ConvexError("Service not found");
		}
		await loadDestination(ctx, backup.organizationId, destinationId);
		await ctx.db.patch("databaseBackups", backupId, {
			destinationId,
			enabled,
			...cleanFields(backup.owner, resolved, fields),
		});
		const updated = await ctx.db.get("databaseBackups", backupId);
		if (updated) await rescheduleBackup(ctx, updated);
		await recordOwnerEvent(
			ctx,
			backup.owner,
			backup.organizationId,
			"config.backups",
			await actorOf(ctx),
			{ action: "update" },
		);
	},
});

// Compose backups only: the password the dump runs with (mysql: root).
export const setCredentials = action({
	args: { backupId: v.id("databaseBackups"), password: v.string() },
	handler: async (ctx, { backupId, password }) => {
		validatePassword(password);
		await ctx.runMutation(internal.databases.backups.storeCredentials, {
			backupId,
			...(await encryptSecret(password)),
		});
	},
});

export const storeCredentials = internalMutation({
	args: {
		backupId: v.id("databaseBackups"),
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, { backupId, iv, ciphertext }) => {
		const { backup } = await loadBackup(ctx, backupId, "update");
		if (backup.owner.kind !== "compose") {
			throw new ConvexError("Database backups use the database's credentials");
		}
		await recordOwnerEvent(
			ctx,
			backup.owner,
			backup.organizationId,
			"config.backups",
			await actorOf(ctx),
			{ action: "update", fields: ["credentials"] },
		);
		await putSecret(ctx, {
			organizationId: backup.organizationId,
			kind: BACKUP_PASSWORD_KIND,
			ownerId: backupId,
			iv,
			ciphertext,
		});
	},
});

export const setEnabled = mutation({
	args: { backupId: v.id("databaseBackups"), enabled: v.boolean() },
	handler: async (ctx, { backupId, enabled }) => {
		const { backup } = await loadBackup(ctx, backupId, "update");
		await ctx.db.patch("databaseBackups", backupId, { enabled });
		await rescheduleBackup(ctx, { ...backup, enabled });
		await recordOwnerEvent(
			ctx,
			backup.owner,
			backup.organizationId,
			"config.backups",
			await actorOf(ctx),
			{ action: "update", fields: [enabled ? "enabled" : "disabled"] },
		);
	},
});

export const deleteBackupRow = async (
	ctx: MutationCtx,
	backup: Doc<"databaseBackups">,
) => {
	await cancelPending(ctx, backup.scheduledFunctionId);
	await deleteSecret(ctx, BACKUP_PASSWORD_KIND, backup._id);
	await ctx.db.delete("databaseBackups", backup._id);
};

export const remove = mutation({
	args: { backupId: v.id("databaseBackups") },
	handler: async (ctx, { backupId }) => {
		const backup = await ctx.db.get("databaseBackups", backupId);
		if (!backup) return;
		await requireBackupPermission(ctx, backup, "delete");
		await deleteBackupRow(ctx, backup);
		await recordOwnerEvent(
			ctx,
			backup.owner,
			backup.organizationId,
			"config.backups",
			await actorOf(ctx),
			{ action: "remove" },
		);
	},
});

export const runNow = mutation({
	args: { backupId: v.id("databaseBackups") },
	handler: async (ctx, { backupId }) => {
		const { backup, userId } = await loadBackup(ctx, backupId, "create");
		const resolved = await resolveOwner(ctx, backup.owner);
		if (!resolved || resolved.organizationId !== backup.organizationId) {
			throw new ConvexError("Service not found");
		}
		return await enqueueRun(ctx, backup, resolved, userId);
	},
});

const publicBackup = ({
	scheduledFunctionId: _f,
	generation: _g,
	...backup
}: Doc<"databaseBackups">) => backup;

export const list = query({
	args: { owner: backupOwner },
	handler: async (ctx, { owner }) => {
		const { resolved } = await requireOwner(ctx, owner, "backup", "read");
		const rows = await ctx.db
			.query("databaseBackups")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_BACKUPS);
		return await Promise.all(
			rows
				.filter((row) => row.organizationId === resolved.organizationId)
				.map(async (backup) => ({
					...publicBackup(backup),
					recentRuns: await recentDeployments(
						ctx,
						{ kind: "databaseBackup", id: backup._id },
						RECENT_RUNS,
					),
				})),
		);
	},
});

export const get = query({
	args: { backupId: v.id("databaseBackups") },
	handler: async (ctx, { backupId }) => {
		const backup = await ctx.db.get("databaseBackups", backupId);
		if (!backup) return null;
		await requireBackupPermission(ctx, backup, "read");
		return publicBackup(backup);
	},
});

export const runs = query({
	args: { backupId: v.id("databaseBackups"), limit: v.optional(v.number()) },
	handler: async (ctx, { backupId, limit }) => {
		const backup = await ctx.db.get("databaseBackups", backupId);
		if (!backup) return [];
		await requireBackupPermission(ctx, backup, "read");
		const take = Math.min(Math.max(limit ?? MAX_RUNS, 1), MAX_RUNS);
		return await recentDeployments(
			ctx,
			{ kind: "databaseBackup", id: backupId },
			take,
		);
	},
});

// Lists this backup's files in its destination folder, newest first; the UI
// follows `api.databases.destinations.opResult({ opId })`.
export const listFiles = mutation({
	args: { backupId: v.id("databaseBackups") },
	handler: async (ctx, { backupId }) => {
		const { backup, userId } = await loadBackup(ctx, backupId, "read");
		const resolved = await resolveOwner(ctx, backup.owner);
		if (!resolved || resolved.organizationId !== backup.organizationId) {
			throw new ConvexError("Service not found");
		}
		await loadDestination(ctx, backup.organizationId, backup.destinationId);
		const serverId = resolved.serverId
			? (ctx.db.normalizeId("servers", resolved.serverId) ?? undefined)
			: undefined;
		return await startOp(ctx, {
			organizationId: backup.organizationId,
			serverId,
			request: {
				kind: "listBackupFiles",
				destinationId: backup.destinationId,
				path: backupFolder(resolved.appName, backup.serviceName, backup.prefix),
				include: `*${BACKUP_EXTENSIONS[backup.databaseType]}`,
			},
			requestedBy: userId,
		});
	},
});

// Restores a dump into a database (or a compose service, using the
// credentials of `backupId`). The file may come from any folder of the
// destination, so a backup can be restored into a fresh database.
export const restore = mutation({
	args: {
		owner: backupOwner,
		backupId: v.optional(v.id("databaseBackups")),
		destinationId: v.id("destinations"),
		backupFile: v.string(),
		databaseName: v.string(),
		databaseType: backupEngine,
	},
	handler: async (ctx, args): Promise<Id<"jobs">> => {
		const { resolved, userId } = await requireOwner(
			ctx,
			args.owner,
			"backup",
			"restore",
		);
		await loadDestination(ctx, resolved.organizationId, args.destinationId);
		const file = args.backupFile.trim();
		if (
			!file ||
			file.length > MAX_BACKUP_FILE ||
			file.startsWith("/") ||
			file.split("/").includes("..") ||
			!file.endsWith(BACKUP_EXTENSIONS[args.databaseType])
		) {
			throw new ConvexError("Invalid backup file");
		}
		await assertBackupFileAccess(ctx, resolved.organizationId, file);
		if (args.databaseType === "libsql") {
			if (!args.databaseName.trim()) {
				throw new ConvexError("Database name is required");
			}
		} else {
			validateIdentifier(args.databaseName.trim(), "Database name");
		}
		if (args.owner.kind === "database") {
			if (resolved.engine !== args.databaseType) {
				throw new ConvexError("Database type does not match the database");
			}
		} else {
			if (!args.backupId) {
				throw new ConvexError(
					"Compose restores need the backup whose credentials to use",
				);
			}
			const backup = await ctx.db.get("databaseBackups", args.backupId);
			if (
				!backup ||
				backup.owner.kind !== args.owner.kind ||
				backup.owner.id !== args.owner.id ||
				backup.databaseType !== args.databaseType
			) {
				throw new ConvexError("Backup not found");
			}
		}
		const jobId = await enqueueJob(ctx, {
			organizationId: resolved.organizationId,
			partition: partitionOf(resolved.serverId),
			group: resolved.group,
			spec: {
				kind: "databases.restore",
				owner: args.owner,
				backupId: args.owner.kind === "compose" ? args.backupId : undefined,
				destinationId: args.destinationId,
				backupFile: file,
				databaseName: args.databaseName.trim(),
				databaseType: args.databaseType,
			},
			idempotent: false,
			requestedBy: userId,
		});
		await ctx.db.insert("deployments", {
			organizationId: resolved.organizationId,
			jobId,
			target:
				args.owner.kind === "database"
					? { kind: "database", id: args.owner.id }
					: { kind: "databaseBackup", id: args.backupId as string },
			title: "Restore backup",
			description: file,
		});
		return jobId;
	},
});

const validateBackupFile = (backupFile: string, databaseType: BackupEngine) => {
	const file = backupFile.trim();
	if (
		!file ||
		file.length > MAX_BACKUP_FILE ||
		file.startsWith("/") ||
		file.split("/").includes("..") ||
		!file.endsWith(BACKUP_EXTENSIONS[databaseType])
	) {
		throw new ConvexError("Invalid backup file");
	}
	return file;
};

// The compose restore form: the service and its database credentials
// are typed in (postgres: user; mariadb/mongo: user and password; mysql: root
// password). The password only lives until the restore ends.
export const restoreCompose = action({
	args: {
		composeId: v.id("compose"),
		serviceName: v.string(),
		databaseUser: v.optional(v.string()),
		databasePassword: v.optional(v.string()),
		destinationId: v.id("destinations"),
		backupFile: v.string(),
		databaseName: v.string(),
		databaseType: backupEngine,
	},
	handler: async (ctx, { databasePassword, ...args }): Promise<Id<"jobs">> => {
		const password = databasePassword ?? "";
		if (password) validatePassword(password);
		return await ctx.runMutation(
			internal.databases.backups.queueComposeRestore,
			{
				...args,
				password: password ? await encryptSecret(password) : undefined,
			},
		);
	},
});

export const queueComposeRestore = internalMutation({
	args: {
		composeId: v.id("compose"),
		serviceName: v.string(),
		databaseUser: v.optional(v.string()),
		password: v.optional(v.object({ iv: v.string(), ciphertext: v.string() })),
		destinationId: v.id("destinations"),
		backupFile: v.string(),
		databaseName: v.string(),
		databaseType: backupEngine,
	},
	handler: async (ctx, { composeId, password, ...args }) => {
		const owner = { kind: "compose" as const, id: composeId };
		const resolved = await resolveOwner(ctx, owner);
		if (!resolved) throw new ConvexError("Service not found");
		const { userId } = await requireServicePermission(
			ctx,
			{ _id: composeId, organizationId: resolved.organizationId },
			"backup",
			"restore",
		);
		const needsUser =
			args.databaseType === "postgres" ||
			args.databaseType === "mariadb" ||
			args.databaseType === "mongo";
		const databaseUser = args.databaseUser?.trim() || undefined;
		if (needsUser && !databaseUser) {
			throw new ConvexError("Database user is required");
		}
		const needsPassword =
			args.databaseType === "mariadb" ||
			args.databaseType === "mongo" ||
			args.databaseType === "mysql";
		if (needsPassword && !password) {
			throw new ConvexError(
				args.databaseType === "mysql"
					? "Root password is required for MySQL"
					: "Database password is required",
			);
		}
		await loadDestination(ctx, resolved.organizationId, args.destinationId);
		const file = validateBackupFile(args.backupFile, args.databaseType);
		await assertBackupFileAccess(ctx, resolved.organizationId, file);
		const databaseName = args.databaseName.trim();
		if (args.databaseType === "libsql") {
			if (!databaseName) throw new ConvexError("Database name is required");
		} else {
			validateIdentifier(databaseName, "Database name");
		}
		const serviceName = args.serviceName.trim();
		if (!COMPOSE_SERVICE_REGEX.test(serviceName)) {
			throw new ConvexError("Service name is required for compose backups");
		}
		if (databaseUser) validateIdentifier(databaseUser, "Database user");
		const jobId = await enqueueJob(ctx, {
			organizationId: resolved.organizationId,
			partition: partitionOf(resolved.serverId),
			group: resolved.group,
			spec: {
				kind: "databases.restore",
				owner,
				serviceName,
				databaseUser,
				destinationId: args.destinationId,
				backupFile: file,
				databaseName,
				databaseType: args.databaseType,
			},
			idempotent: false,
			requestedBy: userId,
		});
		if (password) {
			await putSecret(ctx, {
				organizationId: resolved.organizationId,
				kind: RESTORE_PASSWORD_KIND,
				ownerId: jobId,
				...password,
			});
		}
		// Not under the compose target: that list is the deploy history.
		await ctx.db.insert("deployments", {
			organizationId: resolved.organizationId,
			jobId,
			target: { kind: "composeRestore", id: composeId },
			title: "Restore backup",
			description: file,
		});
		return jobId;
	},
});

export const fire = internalMutation({
	args: { backupId: v.id("databaseBackups"), generation: v.number() },
	handler: async (ctx, { backupId, generation }) => {
		const backup = await ctx.db.get("databaseBackups", backupId);
		if (!backup?.enabled || backup.generation !== generation) return;
		const resolved = await resolveOwner(ctx, backup.owner);
		const destination = await ctx.db.get("destinations", backup.destinationId);
		if (
			!resolved ||
			resolved.organizationId !== backup.organizationId ||
			!destination
		) {
			console.warn(`Disabling backup ${backupId}: its target is gone`);
			await ctx.db.patch("databaseBackups", backupId, { enabled: false });
			await rescheduleBackup(ctx, { ...backup, enabled: false });
			return;
		}
		await enqueueRun(ctx, backup, resolved);
		await rescheduleBackup(ctx, backup);
	},
});

// Scheduled functions are not part of snapshot exports, so after an import
// (or any lost scheduler state) enabled backups have no pending run. Safe to
// run repeatedly: backups with a pending or running fire are left alone.
export const reconcileBackups = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query("databaseBackups")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.paginate({ numItems: RECONCILE_BATCH, cursor: cursor ?? null });
		let rescheduled = 0;
		for (const backup of page.page) {
			if (await hasLiveRun(ctx, backup.scheduledFunctionId)) continue;
			await rescheduleBackup(ctx, backup);
			rescheduled++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.backups.reconcileBackups,
				{ cursor: page.continueCursor },
			);
		}
		return { rescheduled, isDone: page.isDone };
	},
});

// For the compose domain: call when a compose project is deleted.
export const removeForOwner = internalMutation({
	args: backupOwner.fields,
	handler: async (ctx, owner) => {
		const batch = await ctx.db
			.query("databaseBackups")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(REMOVE_BATCH);
		for (const backup of batch) await deleteBackupRow(ctx, backup);
		if (batch.length === REMOVE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.backups.removeForOwner,
				owner,
			);
		}
	},
});
