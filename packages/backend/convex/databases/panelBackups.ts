// Web-server (panel host) backups. The panel's state lives in Convex, so a run
// archives a Convex snapshot export (when the agent has the admin key) plus
// /etc/panara-cloud (Traefik config, certificates, acme.json) into a destination of
// the instance's root organization. See apps/agent/src/databases/panelBackup.ts
// for the archive layout and the restore runbook.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireInstanceAdmin } from "../infra/access";
import { enqueueJob } from "../lib/jobs";
import { nextRunAfter } from "../platform/lib/cron";
import { LOCAL_PARTITION } from "../tables/core";
import {
	cancelPending,
	hasLiveRun,
	loadDestination,
	normalizeS3Path,
	recentDeployments,
	validateKeepLatest,
	validateSchedule,
} from "./lib";
import { startOp } from "./ops";

export const PANEL_BACKUP_GROUP = "panel-backup";
export const PANEL_BACKUP_EXTENSION = ".tar.gz";
const MAX_PANEL_BACKUPS = 20;
const MAX_RUNS = 50;
const RECENT_RUNS = 5;
const RECONCILE_BATCH = 100;
const QUEUED_SCAN = 20;
const MAX_BACKUP_FILE = 1024;

export const panelBackupFolder = (prefix: string) =>
	`panara-cloud-panel/${normalizeS3Path(prefix)}`;

const fields = {
	destinationId: v.id("destinations"),
	cronExpression: v.string(),
	timezone: v.optional(v.string()),
	enabled: v.boolean(),
	prefix: v.string(),
	keepLatestCount: v.optional(v.number()),
	includeEncryptionKey: v.optional(v.boolean()),
};

const cleanFields = (input: {
	cronExpression: string;
	timezone?: string;
	prefix: string;
	keepLatestCount?: number;
	includeEncryptionKey?: boolean;
}) => {
	if (input.prefix.split("/").includes("..")) {
		throw new ConvexError("Invalid prefix");
	}
	validateSchedule(input.cronExpression, input.timezone);
	validateKeepLatest(input.keepLatestCount);
	return {
		cronExpression: input.cronExpression.trim(),
		timezone: input.timezone?.trim() || undefined,
		prefix: input.prefix.trim(),
		keepLatestCount: input.keepLatestCount || undefined,
		includeEncryptionKey: input.includeEncryptionKey ?? false,
	};
};

export const reschedulePanelBackup = async (
	ctx: MutationCtx,
	backup: Doc<"panelBackups">,
) => {
	await cancelPending(ctx, backup.scheduledFunctionId);
	const generation = backup.generation + 1;
	const next = backup.enabled
		? nextRunAfter(backup.cronExpression, backup.timezone, Date.now())
		: null;
	const scheduledFunctionId =
		next === null
			? undefined
			: await ctx.scheduler.runAt(next, internal.databases.panelBackups.fire, {
					panelBackupId: backup._id,
					generation,
				});
	await ctx.db.patch("panelBackups", backup._id, {
		generation,
		nextRunAt: next ?? undefined,
		scheduledFunctionId,
	});
};

const loadPanelBackup = async (
	ctx: QueryCtx,
	panelBackupId: Id<"panelBackups">,
) => {
	const admin = await requireInstanceAdmin(ctx);
	const backup = await ctx.db.get("panelBackups", panelBackupId);
	if (!backup || backup.organizationId !== admin.organizationId) {
		throw new ConvexError("Panel backup not found");
	}
	return { backup, ...admin };
};

const enqueueRun = async (
	ctx: MutationCtx,
	backup: Doc<"panelBackups">,
	requestedBy?: string,
): Promise<Id<"jobs"> | null> => {
	if (!requestedBy) {
		const queued = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_status", (q) =>
				q.eq("group", PANEL_BACKUP_GROUP).eq("status", "queued"),
			)
			.take(QUEUED_SCAN);
		if (
			queued.some(
				(job) =>
					job.spec.kind === "databases.panelBackupRun" &&
					job.spec.panelBackupId === backup._id,
			)
		) {
			return null;
		}
	}
	const jobId = await enqueueJob(ctx, {
		organizationId: backup.organizationId,
		partition: LOCAL_PARTITION,
		// Backups and restores of the panel never overlap.
		group: PANEL_BACKUP_GROUP,
		spec: { kind: "databases.panelBackupRun", panelBackupId: backup._id },
		idempotent: false,
		requestedBy,
	});
	await ctx.db.insert("deployments", {
		organizationId: backup.organizationId,
		jobId,
		target: { kind: "panelBackup", id: backup._id },
		title: "Panel backup",
		description: requestedBy ? "Manual backup" : "Scheduled backup",
	});
	return jobId;
};

export const create = mutation({
	args: fields,
	handler: async (ctx, { destinationId, enabled, ...input }) => {
		const { organizationId } = await requireInstanceAdmin(ctx);
		await loadDestination(ctx, organizationId, destinationId);
		const existing = await ctx.db
			.query("panelBackups")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PANEL_BACKUPS);
		if (existing.length >= MAX_PANEL_BACKUPS) {
			throw new ConvexError("Too many panel backups");
		}
		const panelBackupId = await ctx.db.insert("panelBackups", {
			organizationId,
			destinationId,
			enabled,
			...cleanFields(input),
			generation: 0,
		});
		const backup = await ctx.db.get("panelBackups", panelBackupId);
		if (backup) await reschedulePanelBackup(ctx, backup);
		return panelBackupId;
	},
});

export const update = mutation({
	args: { panelBackupId: v.id("panelBackups"), ...fields },
	handler: async (ctx, { panelBackupId, destinationId, enabled, ...input }) => {
		const { backup } = await loadPanelBackup(ctx, panelBackupId);
		await loadDestination(ctx, backup.organizationId, destinationId);
		await ctx.db.patch("panelBackups", panelBackupId, {
			destinationId,
			enabled,
			...cleanFields(input),
		});
		const updated = await ctx.db.get("panelBackups", panelBackupId);
		if (updated) await reschedulePanelBackup(ctx, updated);
	},
});

export const setEnabled = mutation({
	args: { panelBackupId: v.id("panelBackups"), enabled: v.boolean() },
	handler: async (ctx, { panelBackupId, enabled }) => {
		const { backup } = await loadPanelBackup(ctx, panelBackupId);
		await ctx.db.patch("panelBackups", panelBackupId, { enabled });
		await reschedulePanelBackup(ctx, { ...backup, enabled });
	},
});

export const deletePanelBackupRow = async (
	ctx: MutationCtx,
	backup: Doc<"panelBackups">,
) => {
	await cancelPending(ctx, backup.scheduledFunctionId);
	await ctx.db.delete("panelBackups", backup._id);
};

export const remove = mutation({
	args: { panelBackupId: v.id("panelBackups") },
	handler: async (ctx, { panelBackupId }) => {
		const { backup } = await loadPanelBackup(ctx, panelBackupId);
		await deletePanelBackupRow(ctx, backup);
	},
});

export const runNow = mutation({
	args: { panelBackupId: v.id("panelBackups") },
	handler: async (ctx, { panelBackupId }) => {
		const { backup, userId } = await loadPanelBackup(ctx, panelBackupId);
		await loadDestination(ctx, backup.organizationId, backup.destinationId);
		return await enqueueRun(ctx, backup, userId);
	},
});

const publicBackup = ({
	scheduledFunctionId: _f,
	generation: _g,
	...backup
}: Doc<"panelBackups">) => ({
	...backup,
	folder: panelBackupFolder(backup.prefix),
});

export const list = query({
	args: {},
	handler: async (ctx) => {
		const { organizationId } = await requireInstanceAdmin(ctx);
		const rows = await ctx.db
			.query("panelBackups")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PANEL_BACKUPS);
		return await Promise.all(
			rows.map(async (backup) => ({
				...publicBackup(backup),
				recentRuns: await recentDeployments(
					ctx,
					{ kind: "panelBackup", id: backup._id },
					RECENT_RUNS,
				),
			})),
		);
	},
});

export const runs = query({
	args: { panelBackupId: v.id("panelBackups"), limit: v.optional(v.number()) },
	handler: async (ctx, { panelBackupId, limit }) => {
		await loadPanelBackup(ctx, panelBackupId);
		const take = Math.min(Math.max(limit ?? MAX_RUNS, 1), MAX_RUNS);
		return await recentDeployments(
			ctx,
			{ kind: "panelBackup", id: panelBackupId },
			take,
		);
	},
});

// Lists the archives in this backup's folder, newest first; the UI follows
// `api.databases.destinations.opResult({ opId })`.
export const listFiles = mutation({
	args: { panelBackupId: v.id("panelBackups") },
	handler: async (ctx, { panelBackupId }) => {
		const { backup, userId } = await loadPanelBackup(ctx, panelBackupId);
		await loadDestination(ctx, backup.organizationId, backup.destinationId);
		return await startOp(ctx, {
			organizationId: backup.organizationId,
			request: {
				kind: "listBackupFiles",
				destinationId: backup.destinationId,
				path: panelBackupFolder(backup.prefix),
				include: `panel-backup-*${PANEL_BACKUP_EXTENSION}`,
			},
			requestedBy: userId,
		});
	},
});

// Restores /etc/panara-cloud from an archive and stages its Convex snapshot for a
// manual `convex import` (an import replaces the jobs table this job runs
// from, so it can't be part of the job).
export const restore = mutation({
	args: { destinationId: v.id("destinations"), backupFile: v.string() },
	handler: async (ctx, { destinationId, backupFile }): Promise<Id<"jobs">> => {
		const { organizationId, userId } = await requireInstanceAdmin(ctx);
		await loadDestination(ctx, organizationId, destinationId);
		const file = backupFile.trim();
		if (
			!file ||
			file.length > MAX_BACKUP_FILE ||
			file.startsWith("/") ||
			file.split("/").some((part) => part === ".." || part === "") ||
			!file.endsWith(PANEL_BACKUP_EXTENSION)
		) {
			throw new ConvexError("Invalid backup file");
		}
		const jobId = await enqueueJob(ctx, {
			organizationId,
			partition: LOCAL_PARTITION,
			group: PANEL_BACKUP_GROUP,
			spec: {
				kind: "databases.panelRestore",
				destinationId,
				backupFile: file,
			},
			idempotent: false,
			requestedBy: userId,
		});
		await ctx.db.insert("deployments", {
			organizationId,
			jobId,
			target: { kind: "panelRestore", id: organizationId },
			title: "Restore panel backup",
			description: file,
		});
		return jobId;
	},
});

export const fire = internalMutation({
	args: { panelBackupId: v.id("panelBackups"), generation: v.number() },
	handler: async (ctx, { panelBackupId, generation }) => {
		const backup = await ctx.db.get("panelBackups", panelBackupId);
		if (!backup?.enabled || backup.generation !== generation) return;
		const destination = await ctx.db.get("destinations", backup.destinationId);
		if (!destination || destination.organizationId !== backup.organizationId) {
			console.warn(`Disabling panel backup ${panelBackupId}: no destination`);
			await ctx.db.patch("panelBackups", panelBackupId, { enabled: false });
			await reschedulePanelBackup(ctx, { ...backup, enabled: false });
			return;
		}
		await enqueueRun(ctx, backup);
		await reschedulePanelBackup(ctx, backup);
	},
});

// Scheduled functions are not part of snapshot exports, so after an import
// (or any lost scheduler state) enabled backups have no pending run.
export const reconcilePanelBackups = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query("panelBackups")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.paginate({ numItems: RECONCILE_BATCH, cursor: cursor ?? null });
		let rescheduled = 0;
		for (const backup of page.page) {
			if (await hasLiveRun(ctx, backup.scheduledFunctionId)) continue;
			await reschedulePanelBackup(ctx, backup);
			rescheduled++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.panelBackups.reconcilePanelBackups,
				{ cursor: page.continueCursor },
			);
		}
		return { rescheduled, isDone: page.isDone };
	},
});
