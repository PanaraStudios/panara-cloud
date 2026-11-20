import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

const MAX_ROWS = 100;

// Summary for the account security page. Called only from app functions
// that have already resolved the signed-in user.
export const securityOverview = query({
	args: { userId: v.string() },
	returns: v.object({
		email: v.string(),
		emailVerified: v.boolean(),
		hasPassword: v.boolean(),
		twoFactorEnabled: v.boolean(),
		passkeys: v.number(),
		sessions: v.number(),
	}),
	handler: async (ctx, { userId }) => {
		const user = await ctx.db.get("user", userId as Id<"user">);
		if (!user) {
			return {
				email: "",
				emailVerified: false,
				hasPassword: false,
				twoFactorEnabled: false,
				passkeys: 0,
				sessions: 0,
			};
		}
		const accounts = await ctx.db
			.query("account")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(MAX_ROWS);
		const passkeys = await ctx.db
			.query("passkey")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(MAX_ROWS);
		const now = Date.now();
		const sessions = await ctx.db
			.query("session")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(MAX_ROWS);
		return {
			email: user.email,
			emailVerified: user.emailVerified,
			hasPassword: accounts.some((a) => a.providerId === "credential"),
			twoFactorEnabled: user.twoFactorEnabled === true,
			passkeys: passkeys.length,
			sessions: sessions.filter((s) => s.expiresAt > now).length,
		};
	},
});

const sessionView = v.object({
	id: v.string(),
	userAgent: v.union(v.string(), v.null()),
	createdAt: v.number(),
	updatedAt: v.number(),
	expiresAt: v.number(),
	current: v.boolean(),
});

// Better Auth's /list-sessions returns raw session tokens, so it demands a
// fresh sign-in. This view has no tokens, so it can be shown on any session.
export const listSessions = query({
	args: { userId: v.string(), currentSessionId: v.optional(v.string()) },
	returns: v.array(sessionView),
	handler: async (ctx, { userId, currentSessionId }) => {
		const now = Date.now();
		const sessions = await ctx.db
			.query("session")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(MAX_ROWS);
		return sessions
			.filter((session) => session.expiresAt > now)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((session) => ({
				id: session._id,
				userAgent: session.userAgent ?? null,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				expiresAt: session.expiresAt,
				current: session._id === currentSessionId,
			}));
	},
});

// Signing other devices out only reduces access, so it doesn't need a fresh
// sign-in either. The current session can't be revoked here (use sign-out).
export const revokeSession = mutation({
	args: {
		userId: v.string(),
		sessionId: v.string(),
		currentSessionId: v.optional(v.string()),
	},
	returns: v.boolean(),
	handler: async (ctx, { userId, sessionId, currentSessionId }) => {
		const id = ctx.db.normalizeId("session", sessionId);
		const session = id ? await ctx.db.get("session", id) : null;
		if (
			!session ||
			session.userId !== userId ||
			session._id === currentSessionId
		) {
			return false;
		}
		await ctx.db.delete("session", session._id);
		return true;
	},
});

export const revokeOtherSessions = mutation({
	args: { userId: v.string(), currentSessionId: v.string() },
	returns: v.number(),
	handler: async (ctx, { userId, currentSessionId }) => {
		const sessions = await ctx.db
			.query("session")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(MAX_ROWS);
		let revoked = 0;
		for (const session of sessions) {
			if (session._id === currentSessionId) continue;
			await ctx.db.delete("session", session._id);
			revoked++;
		}
		return revoked;
	},
});

export const organizations = query({
	args: { organizationIds: v.array(v.string()) },
	returns: v.array(
		v.object({
			id: v.string(),
			name: v.string(),
			slug: v.string(),
			logo: v.union(v.string(), v.null()),
		}),
	),
	handler: async (ctx, { organizationIds }) => {
		const rows = await Promise.all(
			organizationIds
				.slice(0, MAX_ROWS)
				.map((id) => ctx.db.get("organization", id as Id<"organization">)),
		);
		return rows.flatMap((org) =>
			org
				? [
						{
							id: org._id,
							name: org.name,
							slug: org.slug,
							logo: org.logo ?? null,
						},
					]
				: [],
		);
	},
});

const MAX_MEMBERS = 500;

// Members of one organization with the user details the users page shows.
// Called only from app functions that have already checked the caller's role.
export const organizationMembers = query({
	args: { organizationId: v.string() },
	returns: v.array(
		v.object({
			id: v.string(),
			userId: v.string(),
			role: v.string(),
			createdAt: v.number(),
			email: v.string(),
			name: v.string(),
			image: v.union(v.string(), v.null()),
			twoFactorEnabled: v.boolean(),
			banned: v.boolean(),
		}),
	),
	handler: async (ctx, { organizationId }) => {
		const members = await ctx.db
			.query("member")
			.withIndex("organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_MEMBERS);
		const rows = await Promise.all(
			members.map(async (member) => {
				const user = await ctx.db.get("user", member.userId as Id<"user">);
				if (!user) return null;
				return {
					id: member._id as string,
					userId: member.userId,
					role: member.role,
					createdAt: member.createdAt,
					email: user.email,
					name: user.name,
					image: user.image ?? null,
					twoFactorEnabled: user.twoFactorEnabled === true,
					banned: user.banned === true,
				};
			}),
		);
		return rows
			.filter((row) => row !== null)
			.sort((a, b) => a.createdAt - b.createdAt);
	},
});

const invitationView = v.object({
	id: v.string(),
	email: v.string(),
	role: v.string(),
	status: v.string(),
	expiresAt: v.number(),
	createdAt: v.number(),
});

export const organizationInvitations = query({
	args: { organizationId: v.string() },
	returns: v.array(invitationView),
	handler: async (ctx, { organizationId }) => {
		const invitations = await ctx.db
			.query("invitation")
			.withIndex("organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_ROWS);
		return invitations.map((invitation) => ({
			id: invitation._id as string,
			email: invitation.email,
			role: invitation.role ?? "member",
			status: invitation.status,
			expiresAt: invitation.expiresAt,
			createdAt: invitation.createdAt,
		}));
	},
});

// Better Auth can only cancel invitations; this removes the record ("Remove
// Invitation"). Scoped to the organization the caller administers.
export const deleteInvitation = mutation({
	args: { organizationId: v.string(), invitationId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { organizationId, invitationId }) => {
		const id = ctx.db.normalizeId("invitation", invitationId);
		const invitation = id ? await ctx.db.get("invitation", id) : null;
		if (!invitation || invitation.organizationId !== organizationId) {
			return false;
		}
		await ctx.db.delete("invitation", invitation._id);
		return true;
	},
});
