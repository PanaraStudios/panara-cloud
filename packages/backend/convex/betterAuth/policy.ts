import { ConvexError, v } from "convex/values";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { SETUP_LINK_INVALID, SETUP_LINK_REQUIRED } from "./setupLink";

export const BOOTSTRAP_KEY = "initial-account" as const;
const MAX_INVITATIONS_CHECKED = 100;

export const SETUP_KEY = "setup" as const;
// How long a sign-up that presented the setup token may take to create its
// user row.
const SETUP_RESERVATION_MS = 10 * 60 * 1000;

const getBootstrap = (ctx: QueryCtx) =>
	ctx.db
		.query("bootstrap")
		.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
		.unique();

const getSetupToken = (ctx: QueryCtx) =>
	ctx.db
		.query("setupToken")
		.withIndex("by_key", (q) => q.eq("key", SETUP_KEY))
		.unique();

export const sha256Hex = async (value: string) => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
};

const hasCredential = async (ctx: QueryCtx, userId: string) =>
	(
		await ctx.db
			.query("account")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.take(10)
	).some((a) => a.providerId === "credential");

// Installer only (install.ts, admin key): replaces any earlier setup token.
export const issueSetupToken = mutation({
	args: { tokenHash: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (await getBootstrap(ctx)) {
			throw new ConvexError("The instance already has an administrator");
		}
		const current = await getSetupToken(ctx);
		if (current) await ctx.db.delete("setupToken", current._id);
		await ctx.db.insert("setupToken", { key: SETUP_KEY, ...args });
		return null;
	},
});

// Sign-up of the first account (auth.ts, before the user insert): checks the
// setup token and reserves it for this email, so the user-create trigger,
// which only sees the new user, can tell the sign-up presented it.
export const reserveSetup = mutation({
	args: { token: v.string(), email: v.string() },
	returns: v.null(),
	handler: async (ctx, { token, email }) => {
		if (await getBootstrap(ctx)) return null;
		const row = await getSetupToken(ctx);
		const now = Date.now();
		if (
			!row ||
			row.expiresAt <= now ||
			row.tokenHash !== (await sha256Hex(token))
		) {
			throw new ConvexError(SETUP_LINK_INVALID);
		}
		if (row.userId) {
			// Better Auth writes the user and its password in separate
			// mutations: a user without a password is a sign-up that failed
			// halfway. Remove it so the setup can be retried.
			const id = ctx.db.normalizeId("user", row.userId);
			const user = id ? await ctx.db.get("user", id) : null;
			if (user && (await hasCredential(ctx, user._id))) {
				throw new ConvexError(SETUP_LINK_INVALID);
			}
			if (user) {
				const sessions = await ctx.db
					.query("session")
					.withIndex("userId", (q) => q.eq("userId", user._id))
					.take(100);
				for (const session of sessions) {
					await ctx.db.delete("session", session._id);
				}
				await ctx.db.delete("user", user._id);
			}
		}
		await ctx.db.patch("setupToken", row._id, {
			email: email.trim().toLowerCase(),
			reservedUntil: now + SETUP_RESERVATION_MS,
			userId: undefined,
		});
		return null;
	},
});

// Runs from the user-create trigger in auth.ts, inside the insert's
// transaction: throwing here rejects the sign-up. Before the instance has an
// administrator, only the sign-up that presented the setup link is admitted;
// it becomes the administrator once its password is stored (completeSetup).
export const admitUser = mutation({
	args: { userId: v.string(), email: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId, email }) => {
		if (await getBootstrap(ctx)) {
			await assertInvited(ctx, email);
			return null;
		}
		const row = await getSetupToken(ctx);
		const now = Date.now();
		if (
			!row ||
			row.userId !== undefined ||
			row.expiresAt <= now ||
			(row.reservedUntil ?? 0) <= now ||
			row.email !== email.trim().toLowerCase()
		) {
			throw new ConvexError(SETUP_LINK_REQUIRED);
		}
		await ctx.db.patch("setupToken", row._id, { userId });
		return null;
	},
});

// Runs from the account-create trigger in auth.ts: the first account becomes
// the instance administrator, and the setup token is used up, only once the
// user has a password, so a sign-up failing in between leaves no
// administrator that can't sign in.
export const completeSetup = mutation({
	args: { userId: v.string(), providerId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId, providerId }) => {
		if (providerId !== "credential" || (await getBootstrap(ctx))) return null;
		const row = await getSetupToken(ctx);
		if (row?.userId !== userId) return null;
		await ctx.db.insert("bootstrap", { key: BOOTSTRAP_KEY, userId });
		await ctx.db.delete("setupToken", row._id);
		return null;
	},
});

// Every account after the first needs a pending, unexpired invitation for its
// email. Shared by the sign-up trigger and admin provisioning (users.ts).
const hasPendingInvitation = async (ctx: QueryCtx, email: string) => {
	const invitations = await ctx.db
		.query("invitation")
		.withIndex("email", (q) => q.eq("email", email.toLowerCase()))
		.take(MAX_INVITATIONS_CHECKED);
	const now = Date.now();
	return invitations.some((i) => i.status === "pending" && i.expiresAt > now);
};

export const assertInvited = async (ctx: QueryCtx, email: string) => {
	if (!(await hasPendingInvitation(ctx, email))) {
		throw new ConvexError("Registration requires a valid invitation");
	}
};

export const invited = query({
	args: { email: v.string() },
	returns: v.boolean(),
	handler: (ctx, { email }) => hasPendingInvitation(ctx, email.trim()),
});

// Whether an invitation link (its id) is open for this email. Holding the
// link proves the address as well as a verification email would: the link
// was mailed to it, or handed over by the administrator who vouches for it.
export const invitationOpen = query({
	args: { invitationId: v.string(), email: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { invitationId, email }) => {
		const id = ctx.db.normalizeId("invitation", invitationId);
		const invitation = id ? await ctx.db.get("invitation", id) : null;
		return (
			invitation !== null &&
			invitation.status === "pending" &&
			invitation.expiresAt > Date.now() &&
			invitation.email.toLowerCase() === email.trim().toLowerCase()
		);
	},
});

// Whether anyone can still create the first account (shown on /signup).
export const registrationOpen = query({
	args: {},
	returns: v.boolean(),
	handler: async (ctx) => {
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		return bootstrap === null;
	},
});

export const isInstanceAdmin = query({
	args: { userId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { userId }) => {
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		return bootstrap?.userId === userId;
	},
});

export const instanceAdminUserId = query({
	args: {},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx) => {
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		return bootstrap?.userId ?? null;
	},
});

// Installer bootstrap (`install.sh create-admin`, through convex/install.ts):
// creates the first account, already verified, for installs that can't send
// account email yet. It does what the sign-up trigger does for the first
// account, so it only works while registration is still open.
export const createInitialAdmin = mutation({
	args: { email: v.string(), name: v.string(), passwordHash: v.string() },
	returns: v.string(),
	handler: async (ctx, args) => {
		const email = args.email.trim().toLowerCase();
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		if (bootstrap) {
			throw new ConvexError("The instance already has an administrator");
		}
		const existing = await ctx.db
			.query("user")
			.withIndex("email_name", (q) => q.eq("email", email))
			.first();
		if (existing) throw new ConvexError("This email already has an account");
		const now = Date.now();
		const userId = await ctx.db.insert("user", {
			name: args.name,
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
		await ctx.db.insert("bootstrap", { key: BOOTSTRAP_KEY, userId });
		const setup = await getSetupToken(ctx);
		if (setup) await ctx.db.delete("setupToken", setup._id);
		return userId;
	},
});

// Operator recovery, CLI only:
// npx convex run --component betterAuth policy:transferInstanceAdmin '{"email":"..."}'
export const transferInstanceAdmin = mutation({
	args: { email: v.string() },
	returns: v.null(),
	handler: async (ctx, { email }) => {
		const user = await ctx.db
			.query("user")
			.withIndex("email_name", (q) => q.eq("email", email.trim().toLowerCase()))
			.first();
		if (!user?.emailVerified) {
			throw new ConvexError("No verified account uses this email");
		}
		const bootstrap = await ctx.db
			.query("bootstrap")
			.withIndex("by_key", (q) => q.eq("key", BOOTSTRAP_KEY))
			.unique();
		if (!bootstrap) throw new ConvexError("No account has been created yet");
		await ctx.db.patch("bootstrap", bootstrap._id, { userId: user._id });
		return null;
	},
});

// Operator recovery for a user who lost both their authenticator and backup
// codes, CLI only:
// npx convex run --component betterAuth policy:resetTwoFactor '{"email":"..."}'
// Signs the user out everywhere so the next sign-in uses the password alone.
export const resetTwoFactor = mutation({
	args: { email: v.string() },
	returns: v.null(),
	handler: async (ctx, { email }) => {
		const user = await ctx.db
			.query("user")
			.withIndex("email_name", (q) => q.eq("email", email.trim().toLowerCase()))
			.first();
		if (!user) throw new ConvexError("No account uses this email");
		const factors = await ctx.db
			.query("twoFactor")
			.withIndex("userId", (q) => q.eq("userId", user._id))
			.take(10);
		for (const factor of factors) await ctx.db.delete("twoFactor", factor._id);
		await ctx.db.patch("user", user._id, { twoFactorEnabled: false });
		const sessions = await ctx.db
			.query("session")
			.withIndex("userId", (q) => q.eq("userId", user._id))
			.take(500);
		for (const session of sessions) await ctx.db.delete("session", session._id);
		return null;
	},
});
