import { hashPassword } from "better-auth/crypto";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import {
	internalAction,
	internalMutation,
	type MutationCtx,
} from "./_generated/server";
import { MIN_PASSWORD_LENGTH, siteUrl } from "./authOptions";
import { sha256Hex } from "./betterAuth/policy";
import { DEFAULT_WEB_SERVER_SETTINGS } from "./infra/webServer";
import { randomToken, resetPasswordUrl } from "./users";

// Called by the installer (packages/backend/scripts/install.mjs) with the
// deployment's admin key. All internal: no user can reach them.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 128;

export const createAdmin = internalAction({
	args: {
		email: v.string(),
		password: v.string(),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ userId: string }> => {
		const email = args.email.trim().toLowerCase();
		if (!EMAIL.test(email) || email.length > 254) {
			throw new ConvexError("Invalid email");
		}
		if (
			args.password.length < MIN_PASSWORD_LENGTH ||
			args.password.length > MAX_PASSWORD_LENGTH
		) {
			throw new ConvexError(
				`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
			);
		}
		const userId: string = await ctx.runMutation(
			components.betterAuth.policy.createInitialAdmin,
			{
				email,
				name: args.name?.trim() || (email.split("@")[0] ?? email),
				passwordHash: await hashPassword(args.password),
			},
		);
		return { userId };
	},
});

// `install.sh reset-password <email>`: a one-time reset link for any account,
// printed on the server. The way back in for the instance administrator on an
// instance without email.
export const passwordResetLink = internalAction({
	args: { email: v.string() },
	handler: async (ctx, { email }): Promise<{ url: string }> => {
		const user = await ctx.runQuery(components.betterAuth.users.findByEmail, {
			email,
		});
		if (!user) throw new ConvexError("No account uses this email");
		const token = randomToken();
		await ctx.runMutation(
			components.betterAuth.users.createPasswordResetToken,
			{
				userId: user.userId,
				token,
				expiresAt: Date.now() + 60 * 60 * 1000,
			},
		);
		return { url: resetPasswordUrl(token) };
	},
});

const SETUP_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// `install.sh setup-link` (and the end of a fresh install): the one-time link
// that creates the first account, the instance administrator. Only its hash
// is stored; a new link replaces the previous one. Fails once an
// administrator exists.
export const setupLink = internalAction({
	args: {},
	handler: async (ctx): Promise<{ url: string; expiresAt: number }> => {
		const token = randomToken();
		const expiresAt = Date.now() + SETUP_LINK_TTL_MS;
		await ctx.runMutation(components.betterAuth.policy.issueSetupToken, {
			tokenHash: await sha256Hex(token),
			expiresAt,
		});
		return {
			url: `${siteUrl()}/signup?setup=${encodeURIComponent(token)}`,
			expiresAt,
		};
	},
});

// Seeds the Web Server settings with what the installer configured, so the
// UI shows the panel domain and a later "apply" rewrites the same routing.
export const configureWebServer = internalMutation({
	args: {
		host: v.optional(v.string()),
		https: v.boolean(),
		letsEncryptEmail: v.optional(v.string()),
		serverIp: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const fields = {
			host: args.host,
			https: args.https,
			certificateType: args.https
				? ("letsencrypt" as const)
				: ("none" as const),
			...(args.letsEncryptEmail
				? { letsEncryptEmail: args.letsEncryptEmail }
				: {}),
			...(args.serverIp ? { serverIp: args.serverIp } : {}),
		};
		const current = await ctx.db
			.query("webServerSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		if (current) {
			await ctx.db.patch("webServerSettings", current._id, fields);
		} else {
			await ctx.db.insert("webServerSettings", {
				...DEFAULT_WEB_SERVER_SETTINGS,
				...fields,
			});
		}
	},
});

type Migration = { name: string; run: (ctx: MutationCtx) => Promise<void> };

// Data migrations, run in order after every functions deploy, each once per
// deployment. Append only: never rename, reorder or remove an entry. A
// migration that touches many documents must schedule batches itself
// (ctx.scheduler) instead of doing the work in one transaction.
export const MIGRATIONS: Migration[] = [];

export const migrate = internalMutation({
	args: {},
	handler: async (ctx): Promise<string[]> => {
		const applied: string[] = [];
		for (const migration of MIGRATIONS) {
			const done = await ctx.db
				.query("installMigrations")
				.withIndex("by_name", (q) => q.eq("name", migration.name))
				.unique();
			if (done) continue;
			await migration.run(ctx);
			await ctx.db.insert("installMigrations", {
				name: migration.name,
				appliedAt: Date.now(),
			});
			applied.push(migration.name);
		}
		return applied;
	},
});
