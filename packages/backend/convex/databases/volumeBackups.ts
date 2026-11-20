import { ConvexError, v } from "convex/values";
import { parse } from "yaml";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { readComposeFile } from "../compose/crud";
import { getRootOrganizationId } from "../infra/access";
import { isReservedName, isTrustedRequester } from "../lib/hostPolicy";
import { enqueueJob } from "../lib/jobs";
import { listMounts } from "../lib/mounts";
import { type Action, requireServicePermission } from "../lib/permissions";
import { actorOf, recordOwnerEvent } from "../lib/serviceEvents";
import { nextRunAfter } from "../platform/lib/cron";
import { volumeOwner } from "../tables/databases";
import { assertBackupFileAccess } from "./backupAccess";
import {
	backupFolder,
	cancelPending,
	hasLiveRun,
	loadDestination,
	partitionOf,
	type ResolvedOwner,
	recentDeployments,
	requireOwner,
	resolveOwner,
	VOLUME_NAME_REGEX,
	type VolumeOwner,
	validateBackupPrefix,
	validateComposeServiceName,
	validateKeepLatest,
	validateSchedule,
} from "./lib";
import { startOp } from "./ops";

const MAX_VOLUME_BACKUPS = 100;
const MAX_RUNS = 50;
const RECENT_RUNS = 5;
const RECONCILE_BATCH = 100;
const REMOVE_BATCH = 100;
const QUEUED_SCAN = 20;
const MAX_BACKUP_FILE = 1024;

const volumeBackupFields = {
	name: v.string(),
	volumeName: v.string(),
	prefix: v.string(),
	serviceName: v.optional(v.string()),
	turnOff: v.boolean(),
	cronExpression: v.string(),
	timezone: v.optional(v.string()),
	keepLatestCount: v.optional(v.number()),
	enabled: v.boolean(),
	destinationId: v.id("destinations"),
};

type Fields = {
	name: string;
	volumeName: string;
	prefix: string;
	serviceName?: string;
	turnOff: boolean;
	cronExpression: string;
	timezone?: string;
	keepLatestCount?: number;
};

// Explicit `name:`s of the compose file's top-level volumes; the others are
// created as <project>_<key> and the project is the compose appName.
const namedComposeVolumes = (content: string): string[] => {
	try {
		const volumes = (parse(content) as { volumes?: unknown } | null)?.volumes;
		if (!volumes || typeof volumes !== "object") return [];
		return Object.values(volumes as Record<string, unknown>).flatMap(
			(volume) => {
				const name = (volume as { name?: unknown } | null)?.name;
				return typeof name === "string" ? [name] : [];
			},
		);
	} catch {
		return [];
	}
};

// A service may only back up or restore volumes it declares itself: its
// volume mounts, or for compose its project's volumes.
const isDeclaredVolume = async (
	ctx: QueryCtx,
	owner: VolumeOwner,
	resolved: ResolvedOwner,
	volumeName: string,
) => {
	if (isReservedName(volumeName)) return false;
	const mounts = await listMounts(ctx, owner);
	if (mounts.some((m) => m.type === "volume" && m.volumeName === volumeName)) {
		return true;
	}
	if (owner.kind !== "compose") return false;
	if (volumeName.startsWith(`${resolved.appName}_`)) return true;
	const composeId = ctx.db.normalizeId("compose", owner.id);
	if (!composeId) return false;
	return namedComposeVolumes(await readComposeFile(ctx, composeId)).includes(
		volumeName,
	);
};

const assertOwnVolume = async (
	ctx: QueryCtx,
	owner: VolumeOwner,
	resolved: ResolvedOwner,
	volumeName: string,
) => {
	if (await isTrustedRequester(ctx, resolved.organizationId)) return;
	if (isReservedName(volumeName)) {
		throw new ConvexError(`${volumeName} is reserved for Panara Cloud`);
	}
	if (!(await isDeclaredVolume(ctx, owner, resolved, volumeName))) {
		throw new ConvexError(
			`${volumeName} is not a volume of this service: add it as a volume mount first`,
		);
	}
};

const cleanFields = (owner: VolumeOwner, fields: Fields) => {
	const name = fields.name.trim();
	if (!name) throw new ConvexError("Name is required");
	const volumeName = fields.volumeName.trim();
	if (!VOLUME_NAME_REGEX.test(volumeName)) {
		throw new ConvexError("Invalid volume name");
	}
	if (owner.kind === "compose") validateComposeServiceName(fields.serviceName);
	validateBackupPrefix(fields.prefix);
	validateSchedule(fields.cronExpression, fields.timezone);
	validateKeepLatest(fields.keepLatestCount);
	return {
		name,
		volumeName,
		prefix: fields.prefix.trim(),
		serviceName:
			owner.kind === "compose" ? fields.serviceName?.trim() : undefined,
		turnOff: fields.turnOff,
		cronExpression: fields.cronExpression.trim(),
		timezone: fields.timezone?.trim() || undefined,
		keepLatestCount: fields.keepLatestCount || undefined,
	};
};

export const rescheduleVolumeBackup = async (
	ctx: MutationCtx,
	volumeBackup: Doc<"volumeBackups">,
) => {
	await cancelPending(ctx, volumeBackup.scheduledFunctionId);
	const generation = volumeBackup.generation + 1;
	const next = volumeBackup.enabled
		? nextRunAfter(
				volumeBackup.cronExpression,
				volumeBackup.timezone,
				Date.now(),
			)
		: null;
	const scheduledFunctionId =
		next === null
			? undefined
			: await ctx.scheduler.runAt(next, internal.databases.volumeBackups.fire, {
					volumeBackupId: volumeBackup._id,
					generation,
				});
	await ctx.db.patch("volumeBackups", volumeBackup._id, {
		generation,
		nextRunAt: next ?? undefined,
		scheduledFunctionId,
	});
};

const requireVolumeBackupPermission = async (
	ctx: QueryCtx,
	volumeBackup: Doc<"volumeBackups">,
	action: Action<"volumeBackup">,
) =>
	await requireServicePermission(
		ctx,
		{ _id: volumeBackup.owner.id, organizationId: volumeBackup.organizationId },
		"volumeBackup",
		action,
	);

const loadVolumeBackup = async (
	ctx: QueryCtx,
	volumeBackupId: Id<"volumeBackups">,
	action: Action<"volumeBackup">,
) => {
	const volumeBackup = await ctx.db.get("volumeBackups", volumeBackupId);
	if (!volumeBackup) throw new ConvexError("Volume backup not found");
	const { userId } = await requireVolumeBackupPermission(
		ctx,
		volumeBackup,
		action,
	);
	return { volumeBackup, userId };
};

const resolveFor = async (
	ctx: QueryCtx,
	volumeBackup: Doc<"volumeBackups">,
) => {
	const resolved = await resolveOwner(ctx, volumeBackup.owner);
	if (!resolved || resolved.organizationId !== volumeBackup.organizationId) {
		throw new ConvexError("Service not found");
	}
	return resolved;
};

const enqueueRun = async (
	ctx: MutationCtx,
	volumeBackup: Doc<"volumeBackups">,
	resolved: ResolvedOwner,
	requestedBy?: string,
): Promise<Id<"jobs"> | null> => {
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
					job.spec.kind === "databases.volumeBackupRun" &&
					job.spec.volumeBackupId === volumeBackup._id,
			)
		) {
			return null;
		}
	}
	const jobId = await enqueueJob(ctx, {
		organizationId: volumeBackup.organizationId,
		partition: partitionOf(resolved.serverId),
		// The owner's group, since stopping the service must not race a deploy.
		group: resolved.group,
		spec: {
			kind: "databases.volumeBackupRun",
			volumeBackupId: volumeBackup._id,
		},
		idempotent: false,
		requestedBy,
	});
	await ctx.db.insert("deployments", {
		organizationId: volumeBackup.organizationId,
		jobId,
		target: { kind: "volumeBackup", id: volumeBackup._id },
		title: "Volume backup",
		description: requestedBy ? "Manual backup" : "Scheduled backup",
	});
	return jobId;
};

export const create = mutation({
	args: { owner: volumeOwner, ...volumeBackupFields },
	handler: async (ctx, { owner, destinationId, enabled, ...fields }) => {
		const { resolved } = await requireOwner(
			ctx,
			owner,
			"volumeBackup",
			"create",
		);
		await loadDestination(ctx, resolved.organizationId, destinationId);
		await assertOwnVolume(ctx, owner, resolved, fields.volumeName.trim());
		const volumeBackupId = await ctx.db.insert("volumeBackups", {
			organizationId: resolved.organizationId,
			owner,
			destinationId,
			enabled,
			...cleanFields(owner, fields),
			generation: 0,
		});
		const volumeBackup = await ctx.db.get("volumeBackups", volumeBackupId);
		if (volumeBackup) await rescheduleVolumeBackup(ctx, volumeBackup);
		await recordOwnerEvent(
			ctx,
			owner,
			resolved.organizationId,
			"config.volumeBackups",
			await actorOf(ctx),
			{ action: "create" },
		);
		return volumeBackupId;
	},
});

export const update = mutation({
	args: { volumeBackupId: v.id("volumeBackups"), ...volumeBackupFields },
	handler: async (
		ctx,
		{ volumeBackupId, destinationId, enabled, ...fields },
	) => {
		const { volumeBackup } = await loadVolumeBackup(
			ctx,
			volumeBackupId,
			"update",
		);
		const resolved = await resolveFor(ctx, volumeBackup);
		await loadDestination(ctx, volumeBackup.organizationId, destinationId);
		await assertOwnVolume(
			ctx,
			volumeBackup.owner,
			resolved,
			fields.volumeName.trim(),
		);
		await ctx.db.patch("volumeBackups", volumeBackupId, {
			destinationId,
			enabled,
			...cleanFields(volumeBackup.owner, fields),
		});
		const updated = await ctx.db.get("volumeBackups", volumeBackupId);
		if (updated) await rescheduleVolumeBackup(ctx, updated);
		await recordOwnerEvent(
			ctx,
			volumeBackup.owner,
			volumeBackup.organizationId,
			"config.volumeBackups",
			await actorOf(ctx),
			{ action: "update" },
		);
	},
});

export const setEnabled = mutation({
	args: { volumeBackupId: v.id("volumeBackups"), enabled: v.boolean() },
	handler: async (ctx, { volumeBackupId, enabled }) => {
		const { volumeBackup } = await loadVolumeBackup(
			ctx,
			volumeBackupId,
			"update",
		);
		await ctx.db.patch("volumeBackups", volumeBackupId, { enabled });
		await rescheduleVolumeBackup(ctx, { ...volumeBackup, enabled });
		await recordOwnerEvent(
			ctx,
			volumeBackup.owner,
			volumeBackup.organizationId,
			"config.volumeBackups",
			await actorOf(ctx),
			{ action: "update", fields: [enabled ? "enabled" : "disabled"] },
		);
	},
});

const deleteRow = async (ctx: MutationCtx, row: Doc<"volumeBackups">) => {
	await cancelPending(ctx, row.scheduledFunctionId);
	await ctx.db.delete("volumeBackups", row._id);
};

export const remove = mutation({
	args: { volumeBackupId: v.id("volumeBackups") },
	handler: async (ctx, { volumeBackupId }) => {
		const volumeBackup = await ctx.db.get("volumeBackups", volumeBackupId);
		if (!volumeBackup) return;
		await requireVolumeBackupPermission(ctx, volumeBackup, "delete");
		await deleteRow(ctx, volumeBackup);
		await recordOwnerEvent(
			ctx,
			volumeBackup.owner,
			volumeBackup.organizationId,
			"config.volumeBackups",
			await actorOf(ctx),
			{ action: "remove" },
		);
	},
});

export const runNow = mutation({
	args: { volumeBackupId: v.id("volumeBackups") },
	handler: async (ctx, { volumeBackupId }) => {
		const { volumeBackup, userId } = await loadVolumeBackup(
			ctx,
			volumeBackupId,
			"create",
		);
		const resolved = await resolveFor(ctx, volumeBackup);
		return await enqueueRun(ctx, volumeBackup, resolved, userId);
	},
});

const publicVolumeBackup = ({
	scheduledFunctionId: _f,
	generation: _g,
	...row
}: Doc<"volumeBackups">) => row;

export const list = query({
	args: { owner: volumeOwner },
	handler: async (ctx, { owner }) => {
		const { resolved } = await requireOwner(ctx, owner, "volumeBackup", "read");
		const rows = await ctx.db
			.query("volumeBackups")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_VOLUME_BACKUPS);
		return await Promise.all(
			rows
				.filter((row) => row.organizationId === resolved.organizationId)
				.map(async (row) => ({
					...publicVolumeBackup(row),
					recentRuns: await recentDeployments(
						ctx,
						{ kind: "volumeBackup", id: row._id },
						RECENT_RUNS,
					),
				})),
		);
	},
});

export const get = query({
	args: { volumeBackupId: v.id("volumeBackups") },
	handler: async (ctx, { volumeBackupId }) => {
		const row = await ctx.db.get("volumeBackups", volumeBackupId);
		if (!row) return null;
		await requireVolumeBackupPermission(ctx, row, "read");
		return publicVolumeBackup(row);
	},
});

export const runs = query({
	args: {
		volumeBackupId: v.id("volumeBackups"),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { volumeBackupId, limit }) => {
		const row = await ctx.db.get("volumeBackups", volumeBackupId);
		if (!row) return [];
		await requireVolumeBackupPermission(ctx, row, "read");
		const take = Math.min(Math.max(limit ?? MAX_RUNS, 1), MAX_RUNS);
		return await recentDeployments(
			ctx,
			{ kind: "volumeBackup", id: volumeBackupId },
			take,
		);
	},
});

export const listFiles = mutation({
	args: { volumeBackupId: v.id("volumeBackups") },
	handler: async (ctx, { volumeBackupId }) => {
		const { volumeBackup, userId } = await loadVolumeBackup(
			ctx,
			volumeBackupId,
			"read",
		);
		const resolved = await resolveFor(ctx, volumeBackup);
		await loadDestination(
			ctx,
			volumeBackup.organizationId,
			volumeBackup.destinationId,
		);
		const serverId = resolved.serverId
			? (ctx.db.normalizeId("servers", resolved.serverId) ?? undefined)
			: undefined;
		return await startOp(ctx, {
			organizationId: volumeBackup.organizationId,
			serverId,
			request: {
				kind: "listBackupFiles",
				destinationId: volumeBackup.destinationId,
				path: backupFolder(
					resolved.appName,
					volumeBackup.serviceName,
					volumeBackup.prefix,
				),
				include: `${volumeBackup.volumeName}-*.tar`,
			},
			requestedBy: userId,
		});
	},
});

// Restores a tar archive into a volume on the owner's host. It refuses
// when a container (running or stopped) still uses the volume.
export const restore = mutation({
	args: {
		owner: volumeOwner,
		serviceName: v.optional(v.string()),
		destinationId: v.id("destinations"),
		volumeName: v.string(),
		backupFile: v.string(),
	},
	handler: async (ctx, args): Promise<Id<"jobs">> => {
		const { resolved, userId } = await requireOwner(
			ctx,
			args.owner,
			"volumeBackup",
			"restore",
		);
		await loadDestination(ctx, resolved.organizationId, args.destinationId);
		const volumeName = args.volumeName.trim();
		if (!VOLUME_NAME_REGEX.test(volumeName)) {
			throw new ConvexError("Invalid volume name");
		}
		await assertOwnVolume(ctx, args.owner, resolved, volumeName);
		if (args.owner.kind === "compose") {
			validateComposeServiceName(args.serviceName);
		}
		const file = args.backupFile.trim();
		if (
			!file ||
			file.length > MAX_BACKUP_FILE ||
			file.startsWith("/") ||
			file.split("/").includes("..") ||
			!file.endsWith(".tar")
		) {
			throw new ConvexError("Invalid backup file");
		}
		await assertBackupFileAccess(ctx, resolved.organizationId, file);
		const jobId = await enqueueJob(ctx, {
			organizationId: resolved.organizationId,
			partition: partitionOf(resolved.serverId),
			group: resolved.group,
			spec: {
				kind: "databases.volumeRestore",
				owner: args.owner,
				serviceName: args.serviceName?.trim() || undefined,
				destinationId: args.destinationId,
				volumeName,
				backupFile: file,
			},
			idempotent: false,
			requestedBy: userId,
		});
		await ctx.db.insert("deployments", {
			organizationId: resolved.organizationId,
			jobId,
			target: { kind: args.owner.kind, id: args.owner.id },
			title: "Volume restore",
			description: `${volumeName} from ${file}`,
		});
		return jobId;
	},
});

export const fire = internalMutation({
	args: { volumeBackupId: v.id("volumeBackups"), generation: v.number() },
	handler: async (ctx, { volumeBackupId, generation }) => {
		const row = await ctx.db.get("volumeBackups", volumeBackupId);
		if (!row?.enabled || row.generation !== generation) return;
		const resolved = await resolveOwner(ctx, row.owner);
		const destination = await ctx.db.get("destinations", row.destinationId);
		if (
			!resolved ||
			resolved.organizationId !== row.organizationId ||
			!destination ||
			!(
				(await isDeclaredVolume(ctx, row.owner, resolved, row.volumeName)) ||
				(await getRootOrganizationId(ctx)) === row.organizationId
			)
		) {
			console.warn(
				`Disabling volume backup ${volumeBackupId}: target gone or volume not owned`,
			);
			await ctx.db.patch("volumeBackups", volumeBackupId, { enabled: false });
			await rescheduleVolumeBackup(ctx, { ...row, enabled: false });
			return;
		}
		await enqueueRun(ctx, row, resolved);
		await rescheduleVolumeBackup(ctx, row);
	},
});

export const reconcileVolumeBackups = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query("volumeBackups")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.paginate({ numItems: RECONCILE_BATCH, cursor: cursor ?? null });
		let rescheduled = 0;
		for (const row of page.page) {
			if (await hasLiveRun(ctx, row.scheduledFunctionId)) continue;
			await rescheduleVolumeBackup(ctx, row);
			rescheduled++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.volumeBackups.reconcileVolumeBackups,
				{ cursor: page.continueCursor },
			);
		}
		return { rescheduled, isDone: page.isDone };
	},
});

// For the applications and compose domains: call on delete.
export const removeForOwner = internalMutation({
	args: volumeOwner.fields,
	handler: async (ctx, owner) => {
		const batch = await ctx.db
			.query("volumeBackups")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(REMOVE_BATCH);
		for (const row of batch) await deleteRow(ctx, row);
		if (batch.length === REMOVE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.volumeBackups.removeForOwner,
				owner,
			);
		}
	},
});
