// Patches: files edited in the UI and written into the cloned
// repository before every build. Owners are `{ kind, id }` services that
// have a routing owner (applications and compose). Compose can call the
// exported helpers from its own agent context and use `applyPatches` from
// apps/agent/src/applications/patches.ts on the host.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireRoutingPermission } from "../infra/routing";
import { requireServicePermission } from "../lib/permissions";
import { actorOf, recordOwnerEvent } from "../lib/serviceEvents";
import { patchType } from "../tables/applications";

export type PatchOwner = { kind: string; id: string };

export type PatchForBuild = {
	filePath: string;
	type: "create" | "update" | "delete";
	content: string;
};

const MAX_PATCHES = 200;
const MAX_CONTENT = 512 * 1024;
const MAX_PATH = 1024;

const patchOwner = v.object({
	kind: v.union(v.literal("application"), v.literal("compose")),
	id: v.string(),
});

export const normalizePatchPath = (filePath: string): string => {
	const path = filePath.trim().replace(/^\.\//, "");
	if (
		!path ||
		path.length > MAX_PATH ||
		path.startsWith("/") ||
		/[\0\r\n]/.test(path) ||
		path.split("/").some((segment) => segment === ".." || segment === "")
	) {
		throw new ConvexError(
			"File path must be relative and stay inside the repository",
		);
	}
	return path;
};

export const listPatches = (ctx: QueryCtx, owner: PatchOwner) =>
	ctx.db
		.query("patches")
		.withIndex("by_owner_and_filePath", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_PATCHES);

const contentOf = async (ctx: QueryCtx, patchId: Id<"patches">) =>
	(
		await ctx.db
			.query("patchContents")
			.withIndex("by_patchId", (q) => q.eq("patchId", patchId))
			.unique()
	)?.content ?? "";

// Enabled patches with their content, for a lease-guarded deploy context.
export const loadPatchesForBuild = async (
	ctx: QueryCtx,
	owner: PatchOwner,
): Promise<PatchForBuild[]> => {
	const patches = (await listPatches(ctx, owner)).filter((p) => p.enabled);
	const result: PatchForBuild[] = [];
	for (const patch of patches) {
		result.push({
			filePath: patch.filePath,
			type: patch.type,
			content: patch.type === "delete" ? "" : await contentOf(ctx, patch._id),
		});
	}
	return result;
};

const findByPath = (ctx: QueryCtx, owner: PatchOwner, filePath: string) =>
	ctx.db
		.query("patches")
		.withIndex("by_owner_and_filePath", (q) =>
			q
				.eq("owner.kind", owner.kind)
				.eq("owner.id", owner.id)
				.eq("filePath", filePath),
		)
		.unique();

const setContent = async (
	ctx: MutationCtx,
	patch: Pick<Doc<"patches">, "_id" | "organizationId">,
	content: string,
) => {
	const existing = await ctx.db
		.query("patchContents")
		.withIndex("by_patchId", (q) => q.eq("patchId", patch._id))
		.unique();
	if (existing) {
		await ctx.db.patch("patchContents", existing._id, { content });
	} else {
		await ctx.db.insert("patchContents", {
			organizationId: patch.organizationId,
			patchId: patch._id,
			content,
		});
	}
};

// Creates or replaces the patch for `filePath`.
export const upsertPatch = async (
	ctx: MutationCtx,
	organizationId: string,
	owner: PatchOwner,
	input: {
		filePath: string;
		content: string;
		type: "create" | "update" | "delete";
	},
): Promise<Id<"patches">> => {
	const filePath = normalizePatchPath(input.filePath);
	if (input.content.length > MAX_CONTENT) {
		throw new ConvexError("Patch content is too large");
	}
	const content =
		input.type === "delete" || input.content.endsWith("\n") || !input.content
			? input.type === "delete"
				? ""
				: input.content
			: `${input.content}\n`;
	const existing = await findByPath(ctx, owner, filePath);
	if (existing) {
		await ctx.db.patch("patches", existing._id, {
			type: input.type,
			updatedAt: Date.now(),
		});
		await setContent(ctx, existing, content);
		return existing._id;
	}
	if ((await listPatches(ctx, owner)).length >= MAX_PATCHES) {
		throw new ConvexError("Too many patches");
	}
	const patchId = await ctx.db.insert("patches", {
		organizationId,
		owner: { kind: owner.kind, id: owner.id },
		filePath,
		type: input.type,
		enabled: true,
		updatedAt: Date.now(),
	});
	await setContent(ctx, { _id: patchId, organizationId }, content);
	return patchId;
};

const deletePatch = async (ctx: MutationCtx, patchId: Id<"patches">) => {
	await ctx.db.delete("patches", patchId);
	const content = await ctx.db
		.query("patchContents")
		.withIndex("by_patchId", (q) => q.eq("patchId", patchId))
		.unique();
	if (content) await ctx.db.delete("patchContents", content._id);
};

// Deletes up to `limit` patches; returns how many were deleted so callers
// can reschedule until it returns 0.
export const removePatchesForOwner = async (
	ctx: MutationCtx,
	owner: PatchOwner,
	limit = 50,
): Promise<number> => {
	const patches = (await listPatches(ctx, owner)).slice(0, limit);
	for (const patch of patches) await deletePatch(ctx, patch._id);
	return patches.length;
};

const loadPatch = async (ctx: QueryCtx, patchId: Id<"patches">) => {
	const patch = await ctx.db.get("patches", patchId);
	if (!patch) throw new ConvexError("Patch not found");
	return patch;
};

const requirePatchPermission = (
	ctx: QueryCtx,
	patch: Doc<"patches">,
	action: "read" | "create" | "delete",
) =>
	requireServicePermission(
		ctx,
		{ _id: patch.owner.id, organizationId: patch.organizationId },
		"service",
		action,
	);

export const list = query({
	args: { owner: patchOwner },
	handler: async (ctx, { owner }) => {
		await requireRoutingPermission(ctx, owner, "service", "read");
		return await listPatches(ctx, owner);
	},
});

export const get = query({
	args: { patchId: v.id("patches") },
	handler: async (ctx, { patchId }) => {
		const patch = await ctx.db.get("patches", patchId);
		if (!patch) return null;
		await requirePatchPermission(ctx, patch, "read");
		return { ...patch, content: await contentOf(ctx, patchId) };
	},
});

// Creates or updates a patch; one patch per file.
export const save = mutation({
	args: {
		owner: patchOwner,
		filePath: v.string(),
		content: v.string(),
		type: v.optional(patchType),
	},
	handler: async (ctx, { owner, filePath, content, type }) => {
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"service",
			"create",
		);
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.patches",
			userId,
			{ path: filePath, action: "update" },
		);
		return await upsertPatch(ctx, row.organizationId, owner, {
			filePath,
			content,
			type: type ?? "update",
		});
	},
});

export const markForDeletion = mutation({
	args: { owner: patchOwner, filePath: v.string() },
	handler: async (ctx, { owner, filePath }) => {
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"service",
			"create",
		);
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.patches",
			userId,
			{ path: filePath, action: "remove" },
		);
		return await upsertPatch(ctx, row.organizationId, owner, {
			filePath,
			content: "",
			type: "delete",
		});
	},
});

export const update = mutation({
	args: {
		patchId: v.id("patches"),
		content: v.optional(v.string()),
		type: v.optional(patchType),
		enabled: v.optional(v.boolean()),
	},
	handler: async (ctx, { patchId, content, type, enabled }) => {
		const patch = await loadPatch(ctx, patchId);
		await requirePatchPermission(ctx, patch, "create");
		await recordOwnerEvent(
			ctx,
			patch.owner,
			patch.organizationId,
			"config.patches",
			await actorOf(ctx),
			{ path: patch.filePath, action: "update" },
		);
		if (content !== undefined || type !== undefined) {
			await upsertPatch(ctx, patch.organizationId, patch.owner, {
				filePath: patch.filePath,
				content: content ?? (await contentOf(ctx, patchId)),
				type: type ?? patch.type,
			});
		}
		if (enabled !== undefined) {
			await ctx.db.patch("patches", patchId, {
				enabled,
				updatedAt: Date.now(),
			});
		}
	},
});

export const remove = mutation({
	args: { patchId: v.id("patches") },
	handler: async (ctx, { patchId }) => {
		const patch = await ctx.db.get("patches", patchId);
		if (!patch) return;
		await requirePatchPermission(ctx, patch, "delete");
		await deletePatch(ctx, patchId);
		await recordOwnerEvent(
			ctx,
			patch.owner,
			patch.organizationId,
			"config.patches",
			await actorOf(ctx),
			{ path: patch.filePath, action: "remove" },
		);
	},
});
