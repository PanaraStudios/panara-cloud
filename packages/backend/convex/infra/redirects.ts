import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { recordOwnerEvent } from "../lib/serviceEvents";
import { routingOwner } from "../tables/infra";
import {
	enqueueRoutingSync,
	MAX_REDIRECTS_PER_OWNER,
	requireOwnedRowPermission,
	requireRoutingPermission,
} from "./routing";
import { validateRegex } from "./validation";

const validateReplacement = (replacement: string) => {
	if (!replacement || replacement.length > 1000) {
		throw new ConvexError("Replacement must be 1-1000 characters");
	}
	return replacement;
};

export const listByOwner = query({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		await requireRoutingPermission(ctx, owner, "service", "read");
		return await ctx.db
			.query("redirects")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_REDIRECTS_PER_OWNER);
	},
});

export const create = mutation({
	args: {
		owner: routingOwner,
		regex: v.string(),
		replacement: v.string(),
		permanent: v.boolean(),
	},
	handler: async (ctx, { owner, regex, replacement, permanent }) => {
		if (owner.kind !== "application") {
			throw new ConvexError("Redirects are only supported for applications");
		}
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"service",
			"create",
		);
		const existing = await ctx.db
			.query("redirects")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_REDIRECTS_PER_OWNER);
		if (existing.length >= MAX_REDIRECTS_PER_OWNER) {
			throw new ConvexError("Too many redirects");
		}
		const redirectId = await ctx.db.insert("redirects", {
			organizationId: row.organizationId,
			owner,
			regex: validateRegex(regex),
			replacement: validateReplacement(replacement),
			permanent,
		});
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.redirects",
			userId,
			{ action: "create" },
		);
		await enqueueRoutingSync(ctx, owner, userId);
		return redirectId;
	},
});

export const update = mutation({
	args: {
		redirectId: v.id("redirects"),
		regex: v.string(),
		replacement: v.string(),
		permanent: v.boolean(),
	},
	handler: async (ctx, { redirectId, regex, replacement, permanent }) => {
		const redirect = await ctx.db.get("redirects", redirectId);
		if (!redirect) throw new ConvexError("Redirect not found");
		const { userId } = await requireOwnedRowPermission(
			ctx,
			redirect,
			"service",
			"create",
		);
		await ctx.db.patch("redirects", redirectId, {
			regex: validateRegex(regex),
			replacement: validateReplacement(replacement),
			permanent,
		});
		await recordOwnerEvent(
			ctx,
			redirect.owner,
			redirect.organizationId,
			"config.redirects",
			userId,
			{ action: "update" },
		);
		await enqueueRoutingSync(ctx, redirect.owner, userId);
	},
});

export const remove = mutation({
	args: { redirectId: v.id("redirects") },
	handler: async (ctx, { redirectId }) => {
		const redirect = await ctx.db.get("redirects", redirectId);
		if (!redirect) return;
		const { userId } = await requireOwnedRowPermission(
			ctx,
			redirect,
			"service",
			"delete",
		);
		await ctx.db.delete("redirects", redirectId);
		await recordOwnerEvent(
			ctx,
			redirect.owner,
			redirect.organizationId,
			"config.redirects",
			userId,
			{ action: "remove" },
		);
		await enqueueRoutingSync(ctx, redirect.owner, userId);
	},
});
