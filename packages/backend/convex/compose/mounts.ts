import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, query } from "../_generated/server";
import { addMount, listMounts, mountInput, updateMount } from "../lib/mounts";
import { requireServicePermission } from "../lib/permissions";
import {
	actorOf,
	mountDetails,
	recordOwnerEvent,
	recordServiceEvent,
} from "../lib/serviceEvents";
import { loadCompose, owner } from "./lib";

// File mounts are written to /etc/panara-cloud/compose/<appName>/files/<filePath>
// and referenced from the compose file as ../files/<filePath>.
export const list = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		await loadCompose(ctx, composeId, "volume", "read");
		return await listMounts(ctx, owner(composeId));
	},
});

export const add = mutation({
	args: { composeId: v.id("compose"), mount: mountInput },
	handler: async (ctx, { composeId, mount }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"volume",
			"create",
		);
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			"config.mounts",
			userId,
			mountDetails(mount, "create"),
		);
		return await addMount(ctx, compose.organizationId, owner(composeId), mount);
	},
});

const loadOwnedMount = async (
	ctx: MutationCtx,
	mountId: Id<"mounts">,
	action: "create" | "delete",
) => {
	const mount = await ctx.db.get("mounts", mountId);
	if (mount?.owner.kind !== "compose") {
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

export const update = mutation({
	args: { mountId: v.id("mounts"), mount: mountInput },
	handler: async (ctx, { mountId, mount }) => {
		const current = await loadOwnedMount(ctx, mountId, "create");
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
		const mount = await loadOwnedMount(ctx, mountId, "delete");
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
