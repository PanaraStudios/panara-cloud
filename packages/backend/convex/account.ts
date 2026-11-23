import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { sessionUser } from "./auth";
import { deliveryMode } from "./email";
import {
	refuseApiKeyForPeople,
	requireMember,
	requireUserId,
} from "./lib/access";
import { requirePermission, resolvePermissions } from "./lib/permissions";
import { markEmailUnproven } from "./lib/unprovenEmails";
import { claimUpload, issueUploadUrl } from "./lib/uploads";

// What the account security page shows: email status, password, 2FA,
// passkeys and active sessions, plus whether the user administers the instance.
export const security = query({
	args: {},
	handler: async (ctx) => {
		const user = await sessionUser(ctx);
		if (!user) return null;
		const overview = await ctx.runQuery(
			components.betterAuth.account.securityOverview,
			{ userId: user._id },
		);
		const instanceAdmin = await ctx.runQuery(
			components.betterAuth.policy.isInstanceAdmin,
			{ userId: user._id },
		);
		return {
			...overview,
			name: user.name,
			image: user.image ?? null,
			instanceAdmin,
		};
	},
});

// Organizations the signed-in user belongs to, with their role in each.
export const organizations = query({
	args: {},
	handler: async (ctx) => {
		const user = await sessionUser(ctx);
		// null (not an empty list) while signed out, so the dashboard can tell
		// "no organizations yet" from a session that is still rotating.
		if (!user) return null;
		const memberships = await ctx.db
			.query("memberships")
			.withIndex("by_userId", (q) => q.eq("userId", user._id))
			.take(100);
		const orgs = await ctx.runQuery(
			components.betterAuth.account.organizations,
			{ organizationIds: memberships.map((m) => m.organizationId) },
		);
		const byOrganization = new Map(
			memberships.map((m) => [m.organizationId, m]),
		);
		return orgs
			.map((org) => ({
				...org,
				role: byOrganization.get(org.id)?.role ?? "member",
				isDefault: byOrganization.get(org.id)?.isDefault === true,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	},
});

// The "Set as default" organization: the one a new session opens in.
export const setDefaultOrganization = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		// Rewrites the default flag on every membership of the user.
		await requireUserId(ctx);
		const { userId } = await requireMember(ctx, organizationId);
		const memberships = await ctx.db
			.query("memberships")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.take(100);
		for (const membership of memberships) {
			const isDefault = membership.organizationId === organizationId;
			if ((membership.isDefault === true) !== isDefault) {
				await ctx.db.patch("memberships", membership._id, { isDefault });
			}
		}
	},
});

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_LENGTH = 2048;
// Raster formats only: an SVG served from storage could run script when
// opened directly.
const AVATAR_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export const generateAvatarUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		return await issueUploadUrl(ctx, userId, "avatar");
	},
});

// Sets the avatar to an uploaded image (2 MB limit, kept in file
// storage) or to a preset/color/Gravatar reference, removing any previously
// uploaded file.
export const updateAvatar = mutation({
	args: {
		storageId: v.optional(v.id("_storage")),
		image: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, { storageId, image }) => {
		const userId = await requireUserId(ctx);
		let next: string | null = image ?? null;
		if (storageId) {
			const file = await claimUpload(ctx, userId, "avatar", storageId);
			const valid =
				file.size <= MAX_AVATAR_BYTES &&
				AVATAR_TYPES.has(file.contentType ?? "");
			if (!valid) {
				// Returned rather than thrown: throwing would roll back the
				// delete and leave the rejected upload in storage.
				await ctx.storage.delete(storageId);
				return {
					image: null,
					error:
						file.size > MAX_AVATAR_BYTES
							? "Image size must be less than 2MB"
							: "Use a PNG, JPEG, GIF or WebP image",
				};
			}
			next = await ctx.storage.getUrl(storageId);
		} else if (
			next !== null &&
			(next.length > MAX_IMAGE_REFERENCE_LENGTH || next.startsWith("data:"))
		) {
			throw new ConvexError("Upload the image instead");
		}
		const previous = await ctx.db
			.query("userAvatars")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.unique();
		if (previous && previous.storageId !== storageId) {
			await ctx.storage.delete(previous.storageId);
			await ctx.db.delete("userAvatars", previous._id);
		}
		if (storageId && previous?.storageId !== storageId) {
			await ctx.db.insert("userAvatars", { userId, storageId });
		}
		await ctx.runMutation(components.betterAuth.users.setImage, {
			userId,
			image: next,
		});
		return { image: next, error: null };
	},
});

const LOGO_UPLOAD = "organization-logo";

export const generateLogoUploadUrl = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"organization",
			"update",
		);
		return await issueUploadUrl(ctx, userId, LOGO_UPLOAD);
	},
});

// Sets an organization's logo to an uploaded image (same limits as an
// avatar), to an image URL, or to none, removing any previously uploaded
// file.
export const updateLogo = mutation({
	args: {
		organizationId: v.string(),
		storageId: v.optional(v.id("_storage")),
		logo: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, { organizationId, storageId, logo }) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"organization",
			"update",
		);
		let next: string | null = logo?.trim() || null;
		if (storageId) {
			const file = await claimUpload(ctx, userId, LOGO_UPLOAD, storageId);
			const valid =
				file.size <= MAX_AVATAR_BYTES &&
				AVATAR_TYPES.has(file.contentType ?? "");
			if (!valid) {
				// Returned rather than thrown, as in updateAvatar.
				await ctx.storage.delete(storageId);
				return {
					logo: null,
					error:
						file.size > MAX_AVATAR_BYTES
							? "Image size must be less than 2MB"
							: "Use a PNG, JPEG, GIF or WebP image",
				};
			}
			next = await ctx.storage.getUrl(storageId);
		} else if (
			next !== null &&
			(next.length > MAX_IMAGE_REFERENCE_LENGTH || !/^https?:\/\//i.test(next))
		) {
			throw new ConvexError("Use an http(s) image URL, or upload the image");
		}
		const previous = await ctx.db
			.query("organizationLogos")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.unique();
		if (previous && previous.storageId !== storageId) {
			await ctx.storage.delete(previous.storageId);
			await ctx.db.delete("organizationLogos", previous._id);
		}
		if (storageId && previous?.storageId !== storageId) {
			await ctx.db.insert("organizationLogos", { organizationId, storageId });
		}
		await ctx.runMutation(components.betterAuth.users.setOrganizationLogo, {
			organizationId,
			logo: next,
		});
		return { logo: next, error: null };
	},
});

// The caller's effective permissions in an organization, for the UI.
export const permissions = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { role, permissions } = await resolvePermissions(ctx, organizationId);
		return { role, permissions };
	},
});

// Whether the first account can still be created; the sign-up page uses it to
// explain that later accounts need an invitation.
export const registrationOpen = query({
	args: {},
	handler: async (ctx): Promise<boolean> =>
		await ctx.runQuery(components.betterAuth.policy.registrationOpen, {}),
});

const requireSignedIn = async (ctx: QueryCtx) => {
	const identity = await ctx.auth.getUserIdentity();
	const user = await sessionUser(ctx);
	if (!identity || !user) throw new ConvexError("Not signed in");
	const sessionId =
		typeof identity.sessionId === "string" ? identity.sessionId : undefined;
	return { userId: user._id, sessionId };
};

// Live list of the signed-in user's sessions (no tokens), marking this one.
export const sessions = query({
	args: {},
	handler: async (ctx) => {
		const user = await sessionUser(ctx);
		if (!user) return null;
		const identity = await ctx.auth.getUserIdentity();
		return await ctx.runQuery(components.betterAuth.account.listSessions, {
			userId: user._id,
			currentSessionId:
				typeof identity?.sessionId === "string"
					? identity.sessionId
					: undefined,
		});
	},
});

export const revokeSession = mutation({
	args: { sessionId: v.string() },
	handler: async (ctx, { sessionId }) => {
		const { userId, sessionId: currentSessionId } = await requireSignedIn(ctx);
		const revoked = await ctx.runMutation(
			components.betterAuth.account.revokeSession,
			{
				userId,
				sessionId,
				currentSessionId,
			},
		);
		if (!revoked) throw new ConvexError("That session is already signed out");
	},
});

export const revokeOtherSessions = mutation({
	args: {},
	handler: async (ctx) => {
		const { userId, sessionId } = await requireSignedIn(ctx);
		if (!sessionId) throw new ConvexError("Sign in again to manage sessions");
		return await ctx.runMutation(
			components.betterAuth.account.revokeOtherSessions,
			{
				userId,
				currentSessionId: sessionId,
			},
		);
	},
});

// The users page of an organization: members with their sign-in details.
export const members = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId, "admin");
		return await ctx.runQuery(
			components.betterAuth.account.organizationMembers,
			{ organizationId },
		);
	},
});

export const invitations = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId, "admin");
		return await ctx.runQuery(
			components.betterAuth.account.organizationInvitations,
			{ organizationId },
		);
	},
});

// Creating and cancelling invitations goes through Better Auth's
// organization plugin; this only deletes the record afterwards.
export const removeInvitation = mutation({
	args: { organizationId: v.string(), invitationId: v.string() },
	handler: async (ctx, { organizationId, invitationId }) => {
		await refuseApiKeyForPeople(ctx);
		await requireMember(ctx, organizationId, "admin");
		const removed = await ctx.runMutation(
			components.betterAuth.account.deleteInvitation,
			{ organizationId, invitationId },
		);
		if (!removed) throw new ConvexError("Invitation not found");
	},
});

const FRESH_SESSION_MS = 5 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email change on an instance without email: applied directly, since nothing
// could deliver the confirmation links. Like Better Auth's sensitive actions,
// it needs a sign-in from the last 5 minutes.
export const changeEmailWithoutConfirmation = mutation({
	args: { newEmail: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { userId, sessionId } = await requireSignedIn(ctx);
		if ((await deliveryMode(ctx)) !== "none") {
			throw new ConvexError(
				"This instance sends email: confirm the change through the link we email you",
			);
		}
		const newEmail = args.newEmail.trim().toLowerCase();
		if (!EMAIL.test(newEmail) || newEmail.length > 254) {
			throw new ConvexError("Invalid email");
		}
		const sessions = await ctx.runQuery(
			components.betterAuth.account.listSessions,
			{ userId, currentSessionId: sessionId },
		);
		const current = sessions.find((s) => s.current);
		if (!current || Date.now() - current.createdAt > FRESH_SESSION_MS) {
			throw new ConvexError(
				"For your security, this needs a recent sign-in. Sign in again, then change your email within 5 minutes.",
			);
		}
		await ctx.runMutation(components.betterAuth.users.changeEmail, {
			userId,
			email: newEmail,
		});
		await markEmailUnproven(ctx, userId, newEmail);
		return null;
	},
});
