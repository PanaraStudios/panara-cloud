import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import {
	type Access,
	hasPermission,
	requirePermission,
	resolvePermissions,
} from "../lib/permissions";
import { deleteSecret, putSecret } from "../lib/secrets";
import { destinationFields } from "../tables/databases";
import { requireOwnBackupFolder } from "./backupAccess";
import { deleteBackupRow } from "./backups";
import {
	cancelPending,
	DESTINATION_DRAFT_KIND,
	DESTINATION_SECRET_KIND,
	loadDestination,
	normalizeS3Path,
} from "./lib";
import { startOp } from "./ops";
import { deletePanelBackupRow } from "./panelBackups";
import { rcloneFlagError } from "./rcloneFlags";

const MAX_DESTINATIONS = 200;

// Members pick a destination in the backup forms; they hold backup.read but
// not destination.read.
const requireDestinationRead = async (
	ctx: QueryCtx,
	organizationId: string,
): Promise<Access> => {
	const access = await resolvePermissions(ctx, organizationId);
	if (
		!hasPermission(access, "destination", "read") &&
		!hasPermission(access, "backup", "read")
	) {
		throw new ConvexError("Requires the destination.read permission");
	}
	return access;
};
const CASCADE_BATCH = 100;
const OP_TTL_MS = 60 * 60 * 1000;
const EXPIRE_BATCH = 200;

const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

type DestinationInput = {
	name: string;
	provider?: string;
	accessKey: string;
	bucket: string;
	region: string;
	endpoint: string;
	additionalFlags: string[];
};

const assertRcloneFlags = (flags: string[]) => {
	if (flags.length > 50) throw new ConvexError("Too many rclone flags");
	for (const flag of flags) {
		const error = rcloneFlagError(flag);
		if (error) throw new ConvexError(error);
	}
};

const clean = (input: DestinationInput): DestinationInput => {
	const name = input.name.trim();
	if (!name) throw new ConvexError("Name is required");
	const bucket = input.bucket.trim();
	if (!bucket) throw new ConvexError("Bucket is required");
	if (!input.accessKey.trim()) throw new ConvexError("Access key is required");
	assertRcloneFlags(input.additionalFlags);
	return {
		name,
		provider: input.provider?.trim() || undefined,
		accessKey: input.accessKey.trim(),
		bucket,
		region: input.region.trim(),
		endpoint: input.endpoint.trim(),
		additionalFlags: input.additionalFlags,
	};
};

// Members reach destinations only through their backups, which pick one by
// name; the bucket, endpoint and access key are for whoever manages them, so
// for members those fields come back empty.
const visibleTo = (
	access: Access,
	destination: Doc<"destinations">,
): Doc<"destinations"> =>
	hasPermission(access, "destination", "read")
		? destination
		: {
				...destination,
				accessKey: "",
				bucket: "",
				region: "",
				endpoint: "",
				additionalFlags: [],
			};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requireDestinationRead(ctx, organizationId);
		const destinations = await ctx.db
			.query("destinations")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_DESTINATIONS);
		return destinations.map((destination) => visibleTo(access, destination));
	},
});

export const get = query({
	args: { destinationId: v.id("destinations") },
	handler: async (ctx, { destinationId }) => {
		const destination = await ctx.db.get("destinations", destinationId);
		if (!destination) return null;
		const access = await requireDestinationRead(
			ctx,
			destination.organizationId,
		);
		return visibleTo(access, destination);
	},
});

export const create = action({
	args: {
		organizationId: v.string(),
		...destinationFields,
		secretAccessKey: v.string(),
	},
	handler: async (
		ctx,
		{ organizationId, secretAccessKey, ...fields },
	): Promise<Id<"destinations">> => {
		if (!secretAccessKey) throw new ConvexError("Secret key is required");
		return await ctx.runMutation(internal.databases.destinations.insert, {
			organizationId,
			...clean(fields),
			secret: await encryptSecret(secretAccessKey),
		});
	},
});

export const insert = internalMutation({
	args: { organizationId: v.string(), ...destinationFields, secret: encrypted },
	handler: async (ctx, { organizationId, secret, ...fields }) => {
		await requirePermission(ctx, organizationId, "destination", "create");
		const destinationId = await ctx.db.insert("destinations", {
			organizationId,
			...clean(fields),
		});
		await putSecret(ctx, {
			organizationId,
			kind: DESTINATION_SECRET_KIND,
			ownerId: destinationId,
			...secret,
		});
		return destinationId;
	},
});

// Omit secretAccessKey to keep the stored one.
export const update = action({
	args: {
		destinationId: v.id("destinations"),
		...destinationFields,
		secretAccessKey: v.optional(v.string()),
	},
	handler: async (ctx, { destinationId, secretAccessKey, ...fields }) => {
		await ctx.runMutation(internal.databases.destinations.replace, {
			destinationId,
			...clean(fields),
			secret: secretAccessKey
				? await encryptSecret(secretAccessKey)
				: undefined,
		});
	},
});

export const replace = internalMutation({
	args: {
		destinationId: v.id("destinations"),
		...destinationFields,
		secret: v.optional(encrypted),
	},
	handler: async (ctx, { destinationId, secret, ...fields }) => {
		const destination = await ctx.db.get("destinations", destinationId);
		if (!destination) throw new ConvexError("Destination not found");
		await requirePermission(
			ctx,
			destination.organizationId,
			"destination",
			"create",
		);
		await ctx.db.replace("destinations", destinationId, {
			organizationId: destination.organizationId,
			...clean(fields),
		});
		if (secret) {
			await putSecret(ctx, {
				organizationId: destination.organizationId,
				kind: DESTINATION_SECRET_KIND,
				ownerId: destinationId,
				...secret,
			});
		}
	},
});

// Removing a destination also deletes the backups that point at it.
export const remove = mutation({
	args: { destinationId: v.id("destinations") },
	handler: async (ctx, { destinationId }) => {
		const destination = await ctx.db.get("destinations", destinationId);
		if (!destination) return;
		await requirePermission(
			ctx,
			destination.organizationId,
			"destination",
			"delete",
		);
		await ctx.db.delete("destinations", destinationId);
		await deleteSecret(ctx, DESTINATION_SECRET_KIND, destinationId);
		await ctx.scheduler.runAfter(
			0,
			internal.databases.destinations.cascadeRemove,
			{ destinationId },
		);
	},
});

export const cascadeRemove = internalMutation({
	args: { destinationId: v.id("destinations") },
	handler: async (ctx, { destinationId }) => {
		const backups = await ctx.db
			.query("databaseBackups")
			.withIndex("by_destinationId", (q) =>
				q.eq("destinationId", destinationId),
			)
			.take(CASCADE_BATCH);
		for (const backup of backups) {
			await deleteBackupRow(ctx, backup);
		}
		const volumeBackups = await ctx.db
			.query("volumeBackups")
			.withIndex("by_destinationId", (q) =>
				q.eq("destinationId", destinationId),
			)
			.take(CASCADE_BATCH);
		for (const volumeBackup of volumeBackups) {
			await cancelPending(ctx, volumeBackup.scheduledFunctionId);
			await ctx.db.delete("volumeBackups", volumeBackup._id);
		}
		const panelBackups = await ctx.db
			.query("panelBackups")
			.withIndex("by_destinationId", (q) =>
				q.eq("destinationId", destinationId),
			)
			.take(CASCADE_BATCH);
		for (const panelBackup of panelBackups) {
			await deletePanelBackupRow(ctx, panelBackup);
		}
		if (
			backups.length === CASCADE_BATCH ||
			volumeBackups.length === CASCADE_BATCH ||
			panelBackups.length === CASCADE_BATCH
		) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.destinations.cascadeRemove,
				{ destinationId },
			);
		}
	},
});

// Tests a saved destination, or unsaved form values (draft) before saving,
// by running `rclone ls` on the panel host or the given server. A draft that
// leaves the secret blank while editing (destinationId given) is tested with
// the destination's stored secret.
export const testConnection = action({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		destinationId: v.optional(v.id("destinations")),
		draft: v.optional(
			v.object({
				...destinationFields,
				secretAccessKey: v.optional(v.string()),
			}),
		),
	},
	handler: async (
		ctx,
		{ organizationId, serverId, destinationId, draft },
	): Promise<{ opId: Id<"databaseOps">; jobId: Id<"jobs"> }> => {
		if (!destinationId && !draft) {
			throw new ConvexError("Pass either a destination or draft settings");
		}
		let draftFields: Omit<DestinationInput, "name"> | undefined;
		let draftSecret: { iv: string; ciphertext: string } | undefined;
		if (draft) {
			const { secretAccessKey, ...fields } = draft;
			const { name: _name, ...rest } = clean(fields);
			draftFields = rest;
			if (secretAccessKey) {
				draftSecret = await encryptSecret(secretAccessKey);
			} else if (!destinationId) {
				throw new ConvexError("Secret key is required");
			}
		}
		return await ctx.runMutation(internal.databases.destinations.queueTest, {
			organizationId,
			serverId,
			destinationId,
			draft: draftFields,
			draftSecret,
		});
	},
});

export const queueTest = internalMutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		destinationId: v.optional(v.id("destinations")),
		draft: v.optional(
			v.object({
				provider: v.optional(v.string()),
				accessKey: v.string(),
				bucket: v.string(),
				region: v.string(),
				endpoint: v.string(),
				additionalFlags: v.array(v.string()),
			}),
		),
		draftSecret: v.optional(encrypted),
	},
	handler: async (ctx, args) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"destination",
			"create",
		);
		if (args.destinationId) {
			await loadDestination(ctx, args.organizationId, args.destinationId);
		}
		if (args.draft) assertRcloneFlags(args.draft.additionalFlags);
		let draftSecret = args.draftSecret;
		if (args.draft && !draftSecret) {
			const { destinationId } = args;
			if (!destinationId) throw new ConvexError("Secret key is required");
			const stored = await ctx.db
				.query("secrets")
				.withIndex("by_kind_and_ownerId", (q) =>
					q.eq("kind", DESTINATION_SECRET_KIND).eq("ownerId", destinationId),
				)
				.unique();
			if (!stored) throw new ConvexError("Destination has no stored secret");
			draftSecret = { iv: stored.iv, ciphertext: stored.ciphertext };
		}
		return await startOp(ctx, {
			organizationId: args.organizationId,
			serverId: args.serverId,
			request: {
				kind: "testDestination",
				// The agent tests the saved destination whenever this is set.
				destinationId: args.draft ? undefined : args.destinationId,
				draft: args.draft,
			},
			draftSecret,
			requestedBy: userId,
		});
	},
});

// Backups live under <appName>/ or, for compose services, under
// <appName>_<serviceName>/; members only browse the folders of services
// they were given.
// Browses the bucket's backup files: `search` is a path whose
// last segment filters names in that folder.
export const listFiles = mutation({
	args: {
		destinationId: v.id("destinations"),
		search: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { destinationId, search, serverId }) => {
		const destination = await ctx.db.get("destinations", destinationId);
		if (!destination) throw new ConvexError("Destination not found");
		const access = await requirePermission(
			ctx,
			destination.organizationId,
			"backup",
			"read",
		);
		const slash = search.lastIndexOf("/");
		const path =
			slash === -1 ? "" : normalizeS3Path(search.slice(0, slash + 1));
		if (path.split("/").includes("..")) throw new ConvexError("Invalid path");
		if (access.scope) {
			await requireOwnBackupFolder(ctx, destination.organizationId, path);
		}
		return await startOp(ctx, {
			organizationId: destination.organizationId,
			serverId,
			request: {
				kind: "listBackupFiles",
				destinationId,
				path,
				search: slash === -1 ? search : search.slice(slash + 1),
			},
			requestedBy: access.userId,
		});
	},
});

export const opResult = query({
	args: { opId: v.id("databaseOps") },
	handler: async (ctx, { opId }) => {
		const op = await ctx.db.get("databaseOps", opId);
		if (!op) return null;
		await requirePermission(ctx, op.organizationId, "backup", "read");
		const job = op.jobId ? await ctx.db.get("jobs", op.jobId) : null;
		return {
			kind: op.request.kind,
			done: op.done,
			status: job?.status ?? null,
			result: op.result ? (JSON.parse(op.result) as unknown) : null,
			error: op.error ?? (job?.status === "failed" ? job.error : null) ?? null,
		};
	},
});

export const expireOps = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - OP_TTL_MS;
		const stale = await ctx.db
			.query("databaseOps")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(EXPIRE_BATCH);
		for (const op of stale) {
			await deleteSecret(ctx, DESTINATION_DRAFT_KIND, op._id);
			await ctx.db.delete("databaseOps", op._id);
		}
	},
});
