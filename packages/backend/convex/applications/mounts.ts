import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { addMount, listMounts, mountInput, updateMount } from "../lib/mounts";
import { requireServicePermission } from "../lib/permissions";
import {
	actorOf,
	mountDetails,
	recordOwnerEvent,
	recordServiceEvent,
} from "../lib/serviceEvents";
import { applicationOwner, requireApplication } from "./lib";

const loadMount = async (
	ctx: QueryCtx,
	mountId: Id<"mounts">,
	action: "read" | "create" | "delete",
) => {
	const mount = await ctx.db.get("mounts", mountId);
	if (mount?.owner.kind !== "application") {
		throw new ConvexError("Mount not found");
	}
	await requireServicePermission(
		ctx,
		{ _id: mount.owner.id, organizationId: mount.organizationId },
		"volume",
		action,
	);
	return mount;
};

export const list = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		await requireApplication(ctx, applicationId, "volume", "read");
		return await listMounts(ctx, applicationOwner(applicationId));
	},
});

export const get = query({
	args: { mountId: v.id("mounts") },
	handler: async (ctx, { mountId }) => await loadMount(ctx, mountId, "read"),
});

export const create = mutation({
	args: { applicationId: v.id("applications"), mount: mountInput },
	handler: async (ctx, { applicationId, mount }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"volume",
			"create",
		);
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"config.mounts",
			userId,
			mountDetails(mount, "create"),
		);
		return await addMount(
			ctx,
			app.organizationId,
			applicationOwner(applicationId),
			mount,
		);
	},
});

export const update = mutation({
	args: { mountId: v.id("mounts"), mount: mountInput },
	handler: async (ctx, { mountId, mount }) => {
		const current = await loadMount(ctx, mountId, "create");
		const siblings = await listMounts(ctx, current.owner);
		if (
			siblings.some((m) => m._id !== mountId && m.mountPath === mount.mountPath)
		) {
			throw new ConvexError(`${mount.mountPath} is already mounted`);
		}
		await updateMount(ctx, mountId, mount);
		await recordOwnerEvent(
			ctx,
			current.owner,
			current.organizationId,
			"config.mounts",
			await actorOf(ctx),
			mountDetails(mount, "update"),
		);
	},
});

export const remove = mutation({
	args: { mountId: v.id("mounts") },
	handler: async (ctx, { mountId }) => {
		const mount = await ctx.db.get("mounts", mountId);
		if (!mount) return;
		await loadMount(ctx, mountId, "delete");
		await ctx.db.delete("mounts", mountId);
		await recordOwnerEvent(
			ctx,
			mount.owner,
			mount.organizationId,
			"config.mounts",
			await actorOf(ctx),
			mountDetails(mount, "remove"),
		);
	},
});
