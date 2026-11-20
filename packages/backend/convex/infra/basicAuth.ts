import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	mutation,
	query,
} from "../_generated/server";
import { recordOwnerEvent } from "../lib/serviceEvents";
import { routingOwner } from "../tables/infra";
import { apr1, randomSalt } from "./htpasswd";
import {
	enqueueDependentSyncs,
	enqueueRoutingSync,
	MAX_USERS_PER_OWNER,
	requireOwnedRowPermission,
	requireRoutingPermission,
} from "./routing";
import { validateUsername } from "./validation";

const validatePassword = (password: string) => {
	if (password.length < 1 || password.length > 256) {
		throw new ConvexError("Password must be 1-256 characters");
	}
	return password;
};

export const listByOwner = query({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		await requireRoutingPermission(ctx, owner, "service", "read");
		const users = await ctx.db
			.query("basicAuthUsers")
			.withIndex("by_owner_and_username", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_USERS_PER_OWNER);
		return users.map(({ passwordHash: _, ...user }) => user);
	},
});

// Hashing runs in an action so the salt comes from a real CSPRNG.
export const create = action({
	args: { owner: routingOwner, username: v.string(), password: v.string() },
	handler: async (ctx, args): Promise<Id<"basicAuthUsers">> => {
		const passwordHash = apr1(validatePassword(args.password), randomSalt());
		return await ctx.runMutation(internal.infra.basicAuth.insert, {
			owner: args.owner,
			username: validateUsername(args.username),
			passwordHash,
		});
	},
});

export const insert = internalMutation({
	args: { owner: routingOwner, username: v.string(), passwordHash: v.string() },
	handler: async (ctx, { owner, username, passwordHash }) => {
		if (owner.kind === "compose") {
			throw new ConvexError("Basic auth is not supported for compose");
		}
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"service",
			"create",
		);
		const users = await ctx.db
			.query("basicAuthUsers")
			.withIndex("by_owner_and_username", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_USERS_PER_OWNER);
		if (users.some((user) => user.username === username)) {
			throw new ConvexError("A user with this username already exists");
		}
		if (users.length >= MAX_USERS_PER_OWNER) {
			throw new ConvexError("Too many basic auth users");
		}
		const id = await ctx.db.insert("basicAuthUsers", {
			organizationId: row.organizationId,
			owner,
			username,
			passwordHash,
		});
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.security",
			userId,
			{ action: "create" },
		);
		await enqueueRoutingSync(ctx, owner, userId);
		await enqueueDependentSyncs(ctx, owner, userId);
		return id;
	},
});

export const update = action({
	args: {
		userId: v.id("basicAuthUsers"),
		username: v.string(),
		password: v.string(),
	},
	handler: async (ctx, args): Promise<null> => {
		const passwordHash = apr1(validatePassword(args.password), randomSalt());
		await ctx.runMutation(internal.infra.basicAuth.replace, {
			id: args.userId,
			username: validateUsername(args.username),
			passwordHash,
		});
		return null;
	},
});

export const replace = internalMutation({
	args: {
		id: v.id("basicAuthUsers"),
		username: v.string(),
		passwordHash: v.string(),
	},
	handler: async (ctx, { id, username, passwordHash }) => {
		const user = await ctx.db.get("basicAuthUsers", id);
		if (!user) throw new ConvexError("User not found");
		const { userId } = await requireOwnedRowPermission(
			ctx,
			user,
			"service",
			"create",
		);
		if (username !== user.username) {
			const clash = await ctx.db
				.query("basicAuthUsers")
				.withIndex("by_owner_and_username", (q) =>
					q
						.eq("owner.kind", user.owner.kind)
						.eq("owner.id", user.owner.id)
						.eq("username", username),
				)
				.first();
			if (clash)
				throw new ConvexError("A user with this username already exists");
		}
		await ctx.db.patch("basicAuthUsers", id, { username, passwordHash });
		await recordOwnerEvent(
			ctx,
			user.owner,
			user.organizationId,
			"config.security",
			userId,
			{ action: "update" },
		);
		await enqueueRoutingSync(ctx, user.owner, userId);
		await enqueueDependentSyncs(ctx, user.owner, userId);
	},
});

export const remove = mutation({
	args: { userId: v.id("basicAuthUsers") },
	handler: async (ctx, args) => {
		const user = await ctx.db.get("basicAuthUsers", args.userId);
		if (!user) return;
		const { userId } = await requireOwnedRowPermission(
			ctx,
			user,
			"service",
			"create",
		);
		await ctx.db.delete("basicAuthUsers", args.userId);
		await recordOwnerEvent(
			ctx,
			user.owner,
			user.organizationId,
			"config.security",
			userId,
			{ action: "remove" },
		);
		await enqueueRoutingSync(ctx, user.owner, userId);
		await enqueueDependentSyncs(ctx, user.owner, userId);
	},
});
