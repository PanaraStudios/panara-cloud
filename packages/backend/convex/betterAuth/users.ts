import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { assertInvited, BOOTSTRAP_KEY } from "./policy";

// Account administration for the app's users.ts. Every function here trusts
// its caller: the app authorizes first and passes ids it has resolved itself.

const BATCH = 200;
const invitableRole = v.union(v.literal("member"), v.literal("admin"));

const findUserByEmail = (ctx: MutationCtx, email: string) =>
	ctx.db
		.query("user")
		.withIndex("email_name", (q) => q.eq("email", email))
		.first();

const pendingInvitations = async (ctx: MutationCtx, email: string) => {
	const now = Date.now();
	return (
		await ctx.db
			.query("invitation")
			.withIndex("email", (q) => q.eq("email", email))
			.take(100)
	).filter((i) => i.status === "pending" && i.expiresAt > now);
};

const requireOrganization = async (
	ctx: MutationCtx,
	organizationId: string,
) => {
	const id = ctx.db.normalizeId("organization", organizationId);
	const organization = id ? await ctx.db.get("organization", id) : null;
	if (!organization) throw new ConvexError("Organization not found");
	return organization;
};

const deleteSessions = async (ctx: MutationCtx, userId: string) => {
	const sessions = await ctx.db
		.query("session")
		.withIndex("userId", (q) => q.eq("userId", userId))
		.take(BATCH);
	for (const session of sessions) await ctx.db.delete("session", session._id);
	return sessions.length === BATCH;
};

// The "initial credentials" invite. The admin vouches for the email,
// so the account starts verified; the sign-up policy still applies: an
// invitation is issued for the email and admission requires it, exactly as
// for a self-service sign-up, then it is marked accepted with the
// membership.
export const provisionUser = mutation({
	args: {
		organizationId: v.string(),
		email: v.string(),
		role: invitableRole,
		passwordHash: v.string(),
		inviterId: v.string(),
	},
	returns: v.object({ userId: v.string(), memberId: v.string() }),
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		await requireOrganization(ctx, args.organizationId);
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		if (!bootstrap) throw new ConvexError("The instance has no administrator");
		if (await findUserByEmail(ctx, email)) {
			throw new ConvexError(
				"This email already has an account. Use the invitation link flow for existing users.",
			);
		}
		const now = Date.now();
		// The admin vouches for the address in their own organization only:
		// another organization's invitation stays for its real owner.
		if (
			(await pendingInvitations(ctx, email)).some(
				(i) => i.organizationId !== args.organizationId,
			)
		) {
			throw new ConvexError(
				"This email has a pending invitation from another organization; invite it instead",
			);
		}
		const invitationId = await ctx.db.insert("invitation", {
			organizationId: args.organizationId,
			email,
			role: args.role,
			status: "pending",
			expiresAt: now + 60_000,
			createdAt: now,
			inviterId: args.inviterId,
		});
		await assertInvited(ctx, email);
		const userId = await ctx.db.insert("user", {
			name: email.split("@")[0] ?? email,
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
			twoFactorEnabled: false,
		});
		await ctx.db.insert("account", {
			accountId: userId,
			providerId: "credential",
			userId,
			password: args.passwordHash,
			createdAt: now,
			updatedAt: now,
		});
		const memberId = await ctx.db.insert("member", {
			organizationId: args.organizationId,
			userId,
			role: args.role,
			createdAt: now,
		});
		await ctx.db.patch("invitation", invitationId, { status: "accepted" });
		return { userId, memberId };
	},
});

// The same record Better Auth's inviteMember writes, so its accept/reject
// endpoints and the /invitation page handle it unchanged.
export const createInvitation = mutation({
	args: {
		organizationId: v.string(),
		email: v.string(),
		role: invitableRole,
		inviterId: v.string(),
		expiresAt: v.number(),
	},
	returns: v.object({ invitationId: v.string(), organizationName: v.string() }),
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		const organization = await requireOrganization(ctx, args.organizationId);
		const user = await findUserByEmail(ctx, email);
		if (user) {
			const member = await ctx.db
				.query("member")
				.withIndex("organizationId_userId", (q) =>
					q.eq("organizationId", args.organizationId).eq("userId", user._id),
				)
				.first();
			if (member) {
				throw new ConvexError("User is already a member of this organization");
			}
		}
		const existing = await ctx.db
			.query("invitation")
			.withIndex("email", (q) => q.eq("email", email))
			.take(100);
		const now = Date.now();
		if (
			existing.some(
				(i) =>
					i.organizationId === args.organizationId &&
					i.status === "pending" &&
					i.expiresAt > now,
			)
		) {
			throw new ConvexError("User is already invited to this organization");
		}
		const invitationId = await ctx.db.insert("invitation", {
			organizationId: args.organizationId,
			email,
			role: args.role,
			status: "pending",
			expiresAt: args.expiresAt,
			createdAt: now,
			inviterId: args.inviterId,
		});
		return { invitationId, organizationName: organization.name };
	},
});

export const accountState = query({
	args: { userId: v.string() },
	returns: v.union(
		v.null(),
		v.object({ email: v.string(), name: v.string(), banned: v.boolean() }),
	),
	handler: async (ctx, { userId }) => {
		const id = ctx.db.normalizeId("user", userId);
		const user = id ? await ctx.db.get("user", id) : null;
		if (!user) return null;
		return { email: user.email, name: user.name, banned: user.banned === true };
	},
});

// Deactivating also signs the user out everywhere; Better Auth then refuses
// new sessions (auth.ts session hook).
export const setBanned = mutation({
	args: { userId: v.string(), banned: v.boolean() },
	returns: v.null(),
	handler: async (ctx, { userId, banned }) => {
		const id = ctx.db.normalizeId("user", userId);
		const user = id ? await ctx.db.get("user", id) : null;
		if (!user) throw new ConvexError("User not found");
		await ctx.db.patch("user", user._id, { banned, updatedAt: Date.now() });
		if (banned) {
			while (await deleteSessions(ctx, user._id)) {}
		}
		return null;
	},
});

export const setImage = mutation({
	args: { userId: v.string(), image: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, { userId, image }) => {
		const id = ctx.db.normalizeId("user", userId);
		if (!id || !(await ctx.db.get("user", id))) {
			throw new ConvexError("User not found");
		}
		await ctx.db.patch("user", id, { image, updatedAt: Date.now() });
		return null;
	},
});

const deleteBatch = async (
	ctx: MutationCtx,
	table: "session" | "account" | "passkey" | "twoFactor" | "member",
	userId: string,
) => {
	const rows = await ctx.db
		.query(table)
		.withIndex("userId", (q) => q.eq("userId", userId))
		.take(BATCH);
	for (const row of rows)
		await ctx.db.delete(table, row._id as Id<typeof table>);
	return rows.length === BATCH;
};

// Removes the account and everything Better Auth keeps for it. Returns false
// while rows remain (the caller schedules another round); the user row goes
// last so a partial run can be resumed.
export const deleteUser = mutation({
	args: { userId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { userId }) => {
		const id = ctx.db.normalizeId("user", userId);
		const user = id ? await ctx.db.get("user", id) : null;
		if (!user) return true;
		for (const table of [
			"session",
			"account",
			"passkey",
			"twoFactor",
			"member",
		] as const) {
			if (await deleteBatch(ctx, table, user._id)) return false;
		}
		const invitations = await ctx.db
			.query("invitation")
			.withIndex("inviterId", (q) => q.eq("inviterId", user._id))
			.take(BATCH);
		for (const invitation of invitations) {
			await ctx.db.delete("invitation", invitation._id);
		}
		if (invitations.length === BATCH) return false;
		await ctx.db.delete("user", user._id);
		return true;
	},
});

export const findByEmail = query({
	args: { email: v.string() },
	returns: v.union(v.null(), v.object({ userId: v.string() })),
	handler: async (ctx, { email }) => {
		const user = await ctx.db
			.query("user")
			.withIndex("email_name", (q) => q.eq("email", email.trim().toLowerCase()))
			.first();
		return user ? { userId: user._id } : null;
	},
});

// The same record Better Auth's requestPasswordReset writes, so the normal
// /reset-password page accepts the token. The caller generates the token in
// an action (unpredictable randomness) and hands the link over itself.
export const createPasswordResetToken = mutation({
	args: { userId: v.string(), token: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, { userId, token, expiresAt }) => {
		const id = ctx.db.normalizeId("user", userId);
		const user = id ? await ctx.db.get("user", id) : null;
		if (!user) throw new ConvexError("User not found");
		const account = await ctx.db
			.query("account")
			.withIndex("userId", (q) => q.eq("userId", user._id))
			.take(20);
		if (!account.some((a) => a.providerId === "credential")) {
			throw new ConvexError("This account doesn't sign in with a password");
		}
		const now = Date.now();
		// The administrator vouches for the address, as with initial
		// credentials, so an account stuck unverified on an instance without
		// email gets in too.
		if (!user.emailVerified) {
			await ctx.db.patch("user", user._id, {
				emailVerified: true,
				updatedAt: now,
			});
		}
		await ctx.db.insert("verification", {
			identifier: `reset-password:${token}`,
			value: user._id,
			expiresAt,
			createdAt: now,
			updatedAt: now,
		});
		return null;
	},
});

// Email change on instances without email: nothing can confirm either
// address, so the caller (account.ts) requires a fresh sign-in instead.
export const changeEmail = mutation({
	args: { userId: v.string(), email: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId, email }) => {
		const id = ctx.db.normalizeId("user", userId);
		const user = id ? await ctx.db.get("user", id) : null;
		if (!user) throw new ConvexError("User not found");
		if (await findUserByEmail(ctx, email)) {
			throw new ConvexError("This email already has an account");
		}
		// Nothing proves the new address, so it can't pick up invitations
		// sent to it: their link is how the invitee joins.
		if ((await pendingInvitations(ctx, email)).length > 0) {
			throw new ConvexError(
				"This email has a pending invitation; open its invitation link to join with it",
			);
		}
		await ctx.db.patch("user", user._id, {
			email,
			emailVerified: true,
			updatedAt: Date.now(),
		});
		return null;
	},
});
