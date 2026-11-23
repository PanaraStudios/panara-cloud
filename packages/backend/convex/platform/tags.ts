import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import {
	canAccessProject,
	requirePermission,
	requireProjectPermission,
} from "../lib/permissions";

const MAX_TAGS = 200;
const MAX_PROJECT_TAGS = 50;
const MAX_LINKS = 2000;
const DELETE_BATCH = 200;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;

const normalize = (name: string, color: string | undefined) => {
	const trimmed = name.trim();
	if (!trimmed) throw new ConvexError("Tag name is required");
	if (trimmed.length > 50) throw new ConvexError("Tag name is too long");
	if (color !== undefined && color !== "" && !COLOR.test(color)) {
		throw new ConvexError("Color must be a hex value like #3b82f6");
	}
	return { name: trimmed, color: color || undefined };
};

const assertNameAvailable = async (
	ctx: MutationCtx,
	organizationId: string,
	name: string,
	exceptId?: Id<"tags">,
) => {
	const existing = await ctx.db
		.query("tags")
		.withIndex("by_organizationId_and_name", (q) =>
			q.eq("organizationId", organizationId).eq("name", name),
		)
		.first();
	if (existing && existing._id !== exceptId) {
		throw new ConvexError(`A tag named "${name}" already exists`);
	}
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "tag", "read");
		return await ctx.db
			.query("tags")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_TAGS);
	},
});

export const get = query({
	args: { tagId: v.id("tags") },
	handler: async (ctx, { tagId }) => {
		const tag = await ctx.db.get("tags", tagId);
		if (!tag) return null;
		await requirePermission(ctx, tag.organizationId, "tag", "read");
		return tag;
	},
});

export const create = mutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		color: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, ...fields }) => {
		await requirePermission(ctx, organizationId, "tag", "create");
		const tag = normalize(fields.name, fields.color);
		await assertNameAvailable(ctx, organizationId, tag.name);
		return await ctx.db.insert("tags", { organizationId, ...tag });
	},
});

export const update = mutation({
	args: {
		tagId: v.id("tags"),
		name: v.optional(v.string()),
		color: v.optional(v.string()),
	},
	handler: async (ctx, { tagId, name, color }) => {
		const tag = await ctx.db.get("tags", tagId);
		if (!tag) throw new ConvexError("Tag not found");
		await requirePermission(ctx, tag.organizationId, "tag", "update");
		const next = normalize(name ?? tag.name, color ?? tag.color);
		await assertNameAvailable(ctx, tag.organizationId, next.name, tagId);
		await ctx.db.patch("tags", tagId, next);
	},
});

export const remove = mutation({
	args: { tagId: v.id("tags") },
	handler: async (ctx, { tagId }) => {
		const tag = await ctx.db.get("tags", tagId);
		if (!tag) return;
		await requirePermission(ctx, tag.organizationId, "tag", "delete");
		await ctx.db.delete("tags", tagId);
		await ctx.scheduler.runAfter(0, internal.platform.tags.deleteLinks, {
			tagId,
		});
	},
});

export const deleteLinks = internalMutation({
	args: { tagId: v.id("tags") },
	handler: async (ctx, { tagId }) => {
		const links = await ctx.db
			.query("projectTags")
			.withIndex("by_tagId", (q) => q.eq("tagId", tagId))
			.take(DELETE_BATCH);
		for (const link of links) await ctx.db.delete("projectTags", link._id);
		if (links.length === DELETE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.platform.tags.deleteLinks, {
				tagId,
			});
		}
	},
});

// For the coordinator's projects.remove cascade.
export const removeProjectLinks = internalMutation({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const links = await ctx.db
			.query("projectTags")
			.withIndex("by_projectId_and_tagId", (q) => q.eq("projectId", projectId))
			.take(DELETE_BATCH);
		for (const link of links) await ctx.db.delete("projectTags", link._id);
	},
});

const loadProject = async (ctx: MutationCtx, projectId: Id<"projects">) => {
	const project = await ctx.db.get("projects", projectId);
	if (!project) throw new ConvexError("Project not found");
	await requireProjectPermission(ctx, project, "tag", "read");
	return project;
};

const loadTag = async (
	ctx: MutationCtx,
	organizationId: string,
	tagId: Id<"tags">,
) => {
	const tag = await ctx.db.get("tags", tagId);
	if (!tag || tag.organizationId !== organizationId) {
		throw new ConvexError("Tag not found");
	}
	return tag;
};

const findLink = (
	ctx: MutationCtx,
	projectId: Id<"projects">,
	tagId: Id<"tags">,
) =>
	ctx.db
		.query("projectTags")
		.withIndex("by_projectId_and_tagId", (q) =>
			q.eq("projectId", projectId).eq("tagId", tagId),
		)
		.first();

export const assignToProject = mutation({
	args: { projectId: v.id("projects"), tagId: v.id("tags") },
	handler: async (ctx, { projectId, tagId }) => {
		const project = await loadProject(ctx, projectId);
		await loadTag(ctx, project.organizationId, tagId);
		if (await findLink(ctx, projectId, tagId)) return;
		await ctx.db.insert("projectTags", {
			organizationId: project.organizationId,
			projectId,
			tagId,
		});
	},
});

export const removeFromProject = mutation({
	args: { projectId: v.id("projects"), tagId: v.id("tags") },
	handler: async (ctx, { projectId, tagId }) => {
		await loadProject(ctx, projectId);
		const link = await findLink(ctx, projectId, tagId);
		if (link) await ctx.db.delete("projectTags", link._id);
	},
});

// Replaces a project's tags with exactly `tagIds`.
export const setProjectTags = mutation({
	args: { projectId: v.id("projects"), tagIds: v.array(v.id("tags")) },
	handler: async (ctx, { projectId, tagIds }) => {
		const project = await loadProject(ctx, projectId);
		const wanted = [...new Set(tagIds)];
		if (wanted.length > MAX_PROJECT_TAGS) {
			throw new ConvexError("Too many tags for one project");
		}
		for (const tagId of wanted) {
			await loadTag(ctx, project.organizationId, tagId);
		}
		const existing = await ctx.db
			.query("projectTags")
			.withIndex("by_projectId_and_tagId", (q) => q.eq("projectId", projectId))
			.take(MAX_PROJECT_TAGS * 2);
		for (const link of existing) {
			if (!wanted.includes(link.tagId)) {
				await ctx.db.delete("projectTags", link._id);
			}
		}
		const present = new Set(existing.map((link) => link.tagId));
		for (const tagId of wanted) {
			if (!present.has(tagId)) {
				await ctx.db.insert("projectTags", {
					organizationId: project.organizationId,
					projectId,
					tagId,
				});
			}
		}
	},
});

export const forProject = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) return [];
		await requireProjectPermission(ctx, project, "tag", "read");
		const links = await ctx.db
			.query("projectTags")
			.withIndex("by_projectId_and_tagId", (q) => q.eq("projectId", projectId))
			.take(MAX_PROJECT_TAGS);
		const tags = await Promise.all(
			links.map((link) => ctx.db.get("tags", link.tagId)),
		);
		return tags.flatMap((tag) => (tag ? [tag] : []));
	},
});

// Project id -> tag ids for an organization's project list (and tag filter).
export const projectTagMap = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(ctx, organizationId, "tag", "read");
		const tags = await ctx.db
			.query("tags")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_TAGS);
		const map: Record<string, Id<"tags">[]> = {};
		let read = 0;
		for (const tag of tags) {
			const links = await ctx.db
				.query("projectTags")
				.withIndex("by_tagId", (q) => q.eq("tagId", tag._id))
				.take(MAX_LINKS - read);
			read += links.length;
			for (const link of links) {
				if (!canAccessProject(access, link.projectId)) continue;
				map[link.projectId] = [...(map[link.projectId] ?? []), tag._id];
			}
			if (read >= MAX_LINKS) break;
		}
		return map;
	},
});
