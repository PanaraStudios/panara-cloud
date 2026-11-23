import { hashPassword } from "better-auth/crypto";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
} from "./_generated/server";
import { MIN_PASSWORD_LENGTH, siteUrl } from "./authOptions";
import { deliveryMode } from "./email";
import { isInstanceAdministrator } from "./infra/access";
import { type Role, refuseApiKeyForPeople, requireCaller } from "./lib/access";
import { requirePermission } from "./lib/permissions";
import { isEmailUnproven, markEmailUnproven } from "./lib/unprovenEmails";
import { revokeLiveSessions } from "./live/revoke";
import { deleteApiKeysOf } from "./platform/lib/apiKeyRows";
import { errorMessage } from "./platform/lib/fetch";
import { invitationEmail } from "./platform/lib/notificationMessages";
import { sendMessage } from "./platform/notificationDelivery";

// Organization user administration beyond what Better Auth's organization
// plugin offers: the initial-credentials invite, invitations sent
// through an email notification channel, deactivation and account deletion.

const MAX_PASSWORD_LENGTH = 128;
const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_MEMBERSHIPS = 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const invitableRole = v.union(v.literal("member"), v.literal("admin"));
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const normalizeEmail = (email: string) => {
	const normalized = email.trim().toLowerCase();
	if (!EMAIL.test(normalized) || normalized.length > 254) {
		throw new ConvexError("Invalid email");
	}
	return normalized;
};

const isInstanceAdmin = (ctx: QueryCtx, userId: string) =>
	ctx.runQuery(components.betterAuth.policy.isInstanceAdmin, { userId });

const membershipsOf = (ctx: QueryCtx, userId: string) =>
	ctx.db
		.query("memberships")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.take(MAX_MEMBERSHIPS);

const invitationUrl = (invitationId: string) =>
	`${siteUrl()}/invitation?id=${encodeURIComponent(invitationId)}`;

// The password is hashed here, with Better Auth's own scrypt parameters, so
// the account signs in through the normal email/password flow.
export const createWithCredentials = action({
	args: {
		organizationId: v.string(),
		email: v.string(),
		password: v.string(),
		role: invitableRole,
	},
	handler: async (ctx, args): Promise<{ userId: string }> => {
		await refuseApiKeyForPeople(ctx);
		const email = normalizeEmail(args.email);
		if (
			args.password.length < MIN_PASSWORD_LENGTH ||
			args.password.length > MAX_PASSWORD_LENGTH
		) {
			throw new ConvexError(
				`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
			);
		}
		return await ctx.runMutation(internal.users.provision, {
			organizationId: args.organizationId,
			email,
			role: args.role,
			passwordHash: await hashPassword(args.password),
		});
	},
});

export const provision = internalMutation({
	args: {
		organizationId: v.string(),
		email: v.string(),
		role: invitableRole,
		passwordHash: v.string(),
	},
	handler: async (ctx, args): Promise<{ userId: string }> => {
		await refuseApiKeyForPeople(ctx);
		const { userId: inviterId } = await requirePermission(
			ctx,
			args.organizationId,
			"member",
			"create",
		);
		const { userId, memberId } = await ctx.runMutation(
			components.betterAuth.users.provisionUser,
			{ ...args, inviterId },
		);
		await markEmailUnproven(ctx, userId, args.email, args.organizationId);
		// Written directly (not through the adapter), so the member trigger
		// doesn't run; mirror it here in the same transaction.
		await ctx.db.insert("memberships", {
			memberId,
			organizationId: args.organizationId,
			userId,
			role: args.role,
			isDefault: true,
		});
		return { userId };
	},
});

// "Add Invitation" with its email provider choice: the invitation
// is emailed through one of the organization's email/Resend notification
// channels, or by default through the built-in account mailer (Resend).
// The invitation stays even if delivery fails, so its link can be copied.
export const invite = action({
	args: {
		organizationId: v.string(),
		email: v.string(),
		role: invitableRole,
		notificationId: v.optional(v.id("notifications")),
	},
	handler: async (
		ctx,
		args,
	): Promise<{
		invitationId: string;
		url: string;
		emailed: boolean;
		emailError: string | null;
	}> => {
		await refuseApiKeyForPeople(ctx);
		const created = await ctx.runMutation(internal.users.createInvitation, {
			...args,
			email: normalizeEmail(args.email),
		});
		const url = invitationUrl(created.invitationId);
		if (!created.channel && created.emailMode === "none") {
			return {
				invitationId: created.invitationId,
				url,
				emailed: false,
				emailError: null,
			};
		}
		try {
			if (created.channel) {
				const target = await ctx.runQuery(
					internal.platform.notifications.loadForDelivery,
					{ notificationId: created.channel },
				);
				if (!target) throw new ConvexError("Email provider not found");
				if (
					target.channel.type !== "email" &&
					target.channel.type !== "resend"
				) {
					throw new ConvexError("Choose an email or Resend notification");
				}
				const mail = invitationEmail({
					email: created.email,
					inviteLink: url,
					organizationName: created.organizationName,
					inviterName: created.inviterName,
				});
				const now = new Date();
				await sendMessage(
					ctx,
					{ ...target.channel, toAddresses: [created.email] },
					target.credentials,
					{
						title: mail.subject,
						emoji: "✉️",
						status: "success",
						shortcode: "email",
						facts: [],
						custom: {},
						email: { subject: mail.subject, html: mail.html },
						date: now.toUTCString(),
						timestamp: now.toISOString(),
					},
				);
			} else {
				await ctx.runMutation(internal.authEmail.send, {
					to: created.email,
					kind: "invite",
					url,
					organizationName: created.organizationName,
					inviterName: created.inviterName,
				});
			}
			return {
				invitationId: created.invitationId,
				url,
				emailed: true,
				emailError: null,
			};
		} catch (error) {
			return {
				invitationId: created.invitationId,
				url,
				emailed: false,
				emailError: errorMessage(error),
			};
		}
	},
});

export const createInvitation = internalMutation({
	args: {
		organizationId: v.string(),
		email: v.string(),
		role: invitableRole,
		notificationId: v.optional(v.id("notifications")),
	},
	handler: async (ctx, args) => {
		await refuseApiKeyForPeople(ctx);
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"invitation",
			"create",
		);
		if (args.notificationId) {
			const notification = await ctx.db.get(
				"notifications",
				args.notificationId,
			);
			if (
				!notification ||
				notification.organizationId !== args.organizationId ||
				(notification.channel.type !== "email" &&
					notification.channel.type !== "resend")
			) {
				throw new ConvexError("Email provider not found");
			}
		}
		const { invitationId, organizationName } = await ctx.runMutation(
			components.betterAuth.users.createInvitation,
			{
				organizationId: args.organizationId,
				email: args.email,
				role: args.role,
				inviterId: userId,
				expiresAt: Date.now() + INVITATION_TTL_MS,
			},
		);
		const inviter = await ctx.runQuery(
			components.betterAuth.users.accountState,
			{ userId },
		);
		return {
			invitationId,
			organizationName,
			email: args.email,
			inviterName: inviter?.name || inviter?.email,
			channel: args.notificationId ?? null,
			emailMode: await deliveryMode(ctx),
		};
	},
});

// Deactivation and password resets are account-wide (they lock the user out
// of every organization), so an organization's owner or admin may only act on
// someone ranked below them who belongs to no other organization; the
// instance administrator may act on anyone but themselves.
const ACCOUNT_CHANGE_MESSAGES = {
	status: {
		self: "You cannot change your own account status",
		instanceAdmin: "The instance administrator cannot be deactivated",
		rank: "You can only change the status of users with a lower role",
	},
	password: {
		self: "Change your own password from your account page",
		instanceAdmin:
			"The instance administrator resets their password on the server: curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s reset-password <email>",
		rank: "You can only reset the password of users with a lower role",
	},
};

const authorizeAccountChange = async (
	ctx: MutationCtx,
	organizationId: string,
	targetUserId: string,
	change: keyof typeof ACCOUNT_CHANGE_MESSAGES = "status",
) => {
	const messages = ACCOUNT_CHANGE_MESSAGES[change];
	const caller = await refuseApiKeyForPeople(ctx);
	const { userId, role } = await requirePermission(
		ctx,
		organizationId,
		"member",
		"update",
	);
	if (targetUserId === userId) {
		throw new ConvexError(messages.self);
	}
	const memberships = await membershipsOf(ctx, targetUserId);
	const target = memberships.find((m) => m.organizationId === organizationId);
	if (!target) {
		throw new ConvexError("Target user is not a member of this organization");
	}
	if (await isInstanceAdmin(ctx, targetUserId)) {
		throw new ConvexError(messages.instanceAdmin);
	}
	if (await isInstanceAdministrator(ctx, caller)) {
		return memberships;
	}
	if (RANK[target.role] >= RANK[role]) {
		throw new ConvexError(messages.rank);
	}
	if (memberships.some((m) => m.organizationId !== organizationId)) {
		throw new ConvexError(
			"This user belongs to other organizations; ask the instance administrator",
		);
	}
	return memberships;
};

const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export const randomToken = () => {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

export const resetPasswordUrl = (token: string) =>
	`${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`;

// A one-time password reset link the administrator hands over themselves,
// for instances without email (and for anyone locked out). The token is
// Better Auth's own reset token, so the normal reset page redeems it.
export const passwordResetLink = action({
	args: { organizationId: v.string(), userId: v.string() },
	handler: async (ctx, args): Promise<{ url: string; expiresAt: number }> => {
		await refuseApiKeyForPeople(ctx);
		const token = randomToken();
		const expiresAt = Date.now() + RESET_LINK_TTL_MS;
		await ctx.runMutation(internal.users.storePasswordResetToken, {
			...args,
			token,
			expiresAt,
		});
		return { url: resetPasswordUrl(token), expiresAt };
	},
});

export const storePasswordResetToken = internalMutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		token: v.string(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		await authorizeAccountChange(
			ctx,
			args.organizationId,
			args.userId,
			"password",
		);
		// Whoever holds the link controls the account; unless that's the
		// instance administrator, the address is no longer proven.
		if (!(await isInstanceAdministrator(ctx, await requireCaller(ctx)))) {
			const account = await ctx.runQuery(
				components.betterAuth.users.accountState,
				{ userId: args.userId },
			);
			if (account) {
				await markEmailUnproven(
					ctx,
					args.userId,
					account.email,
					args.organizationId,
				);
			}
		}
		await ctx.runMutation(
			components.betterAuth.users.createPasswordResetToken,
			{
				userId: args.userId,
				token: args.token,
				expiresAt: args.expiresAt,
			},
		);
	},
});

export const setDeactivated = mutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		deactivated: v.boolean(),
	},
	handler: async (ctx, { organizationId, userId, deactivated }) => {
		const memberships = await authorizeAccountChange(
			ctx,
			organizationId,
			userId,
		);
		await ctx.runMutation(components.betterAuth.users.setBanned, {
			userId,
			banned: deactivated,
		});
		for (const membership of memberships) {
			await ctx.db.patch("memberships", membership._id, { deactivated });
			if (deactivated) {
				await deleteApiKeysOf(ctx, userId, membership.organizationId);
			}
		}
		if (deactivated) await revokeLiveSessions(ctx, { userId });
	},
});

// Deletes the account itself ("Delete User"), not only one
// membership. Instance administrator only, since it affects every
// organization the user belongs to.
export const removeAccount = mutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId: targetUserId }) => {
		const caller = await refuseApiKeyForPeople(ctx);
		const { userId } = caller;
		if (!(await isInstanceAdministrator(ctx, caller))) {
			throw new ConvexError(
				"Only the instance administrator can delete accounts",
			);
		}
		if (targetUserId === userId) {
			throw new ConvexError("You cannot delete your own account here");
		}
		const account = await ctx.runQuery(
			components.betterAuth.users.accountState,
			{ userId: targetUserId },
		);
		if (!account) throw new ConvexError("User not found");
		const memberships = await membershipsOf(ctx, targetUserId);
		if (memberships.some((m) => m.role === "owner")) {
			throw new ConvexError(
				"This user owns an organization; delete that organization first",
			);
		}
		for (const membership of memberships) {
			await deleteApiKeysOf(ctx, targetUserId, membership.organizationId);
			const bookmarks = await ctx.db
				.query("templateBookmarks")
				.withIndex("by_organizationId_and_userId_and_templateId", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("userId", targetUserId),
				)
				.take(MAX_MEMBERSHIPS);
			for (const bookmark of bookmarks) {
				await ctx.db.delete("templateBookmarks", bookmark._id);
			}
			await ctx.db.delete("memberships", membership._id);
		}
		await deleteAvatarFile(ctx, targetUserId);
		await finishDeletion(ctx, targetUserId);
	},
});

const finishDeletion = async (ctx: MutationCtx, userId: string) => {
	const done = await ctx.runMutation(components.betterAuth.users.deleteUser, {
		userId,
	});
	if (!done) {
		await ctx.scheduler.runAfter(0, internal.users.continueDeletion, {
			userId,
		});
	}
};

export const continueDeletion = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		await finishDeletion(ctx, userId);
	},
});

export const deleteAvatarFile = async (ctx: MutationCtx, userId: string) => {
	const avatar = await ctx.db
		.query("userAvatars")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.unique();
	if (!avatar) return;
	await ctx.storage.delete(avatar.storageId as Id<"_storage">);
	await ctx.db.delete("userAvatars", avatar._id);
};

// Consulted by Better Auth whenever it creates a session (auth.ts): refuses
// deactivated accounts and opens the session in the user's default
// organization.
// For auth.ts: whether the user's current address is unproven.
export const emailUnproven = internalQuery({
	args: { userId: v.string(), email: v.string() },
	handler: (ctx, { userId, email }) => isEmailUnproven(ctx, userId, email),
});

export const sessionPolicy = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		const account = await ctx.runQuery(
			components.betterAuth.users.accountState,
			{ userId },
		);
		const memberships = await membershipsOf(ctx, userId);
		return {
			deactivated: account?.banned === true,
			defaultOrganizationId:
				memberships.find((m) => m.isDefault)?.organizationId ?? null,
		};
	},
});
