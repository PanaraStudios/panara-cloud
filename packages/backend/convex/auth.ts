import {
	type AuthFunctions,
	createClient,
	type GenericCtx,
} from "@convex-dev/better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { ConvexError } from "convex/values";
import { api, components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { type AuthEmail, NO_EMAIL_MESSAGES } from "./authEmail";
import { enforceAuthRateLimit } from "./authLimits";
import { createAuthOptions, siteUrl } from "./authOptions";
import authSchema from "./betterAuth/schema";
import { SETUP_LINK_REQUIRED } from "./betterAuth/setupLink";
import { optionalCaller, toRole } from "./lib/access";
import { revokeLiveSessions } from "./live/revoke";
import {
	deleteApiKeysOf,
	deleteApiKeysWithoutAccess,
} from "./platform/lib/apiKeyRows";

const authFunctions: AuthFunctions = internal.auth;

export const authComponent = createClient<DataModel, typeof authSchema>(
	components.betterAuth,
	{
		local: { schema: authSchema },
		authFunctions,
		triggers: {
			user: {
				// Rejects the sign-up unless it carries the setup link (first
				// account) or is invited.
				onCreate: async (ctx, user) => {
					await ctx.runMutation(components.betterAuth.policy.admitUser, {
						userId: user._id,
						email: user.email,
					});
				},
			},
			account: {
				// The first account becomes the administrator once it has a password.
				onCreate: async (ctx, account) => {
					await ctx.runMutation(components.betterAuth.policy.completeSetup, {
						userId: account.userId,
						providerId: account.providerId,
					});
				},
			},
			organization: {
				onDelete: async (ctx, doc) => {
					await ctx.scheduler.runAfter(0, internal.organizationCascade.run, {
						organizationId: doc._id,
					});
				},
			},
			member: {
				onCreate: async (ctx, doc) => {
					const [account, existing] = await Promise.all([
						ctx.runQuery(components.betterAuth.users.accountState, {
							userId: doc.userId,
						}),
						ctx.db
							.query("memberships")
							.withIndex("by_userId", (q) => q.eq("userId", doc.userId))
							.first(),
					]);
					await ctx.db.insert("memberships", {
						memberId: doc._id,
						organizationId: doc.organizationId,
						userId: doc.userId,
						role: toRole(doc.role),
						...(account?.banned ? { deactivated: true } : {}),
						...(existing ? {} : { isDefault: true }),
					});
				},
				onUpdate: async (ctx, doc) => {
					const mirror = await ctx.db
						.query("memberships")
						.withIndex("by_memberId", (q) => q.eq("memberId", doc._id))
						.unique();
					if (mirror && mirror.role !== toRole(doc.role)) {
						await ctx.db.patch("memberships", mirror._id, {
							role: toRole(doc.role),
						});
						await deleteApiKeysWithoutAccess(
							ctx,
							doc.userId,
							doc.organizationId,
							toRole(doc.role),
						);
						await revokeLiveSessions(ctx, {
							userId: doc.userId,
							organizationId: doc.organizationId,
						});
					}
				},
				onDelete: async (ctx, doc) => {
					const mirror = await ctx.db
						.query("memberships")
						.withIndex("by_memberId", (q) => q.eq("memberId", doc._id))
						.unique();
					if (mirror) {
						await ctx.db.delete("memberships", mirror._id);
					}
					const grants = await ctx.db
						.query("memberGrants")
						.withIndex("by_organizationId_and_userId", (q) =>
							q
								.eq("organizationId", doc.organizationId)
								.eq("userId", doc.userId),
						)
						.unique();
					if (grants) await ctx.db.delete("memberGrants", grants._id);
					await deleteApiKeysOf(ctx, doc.userId, doc.organizationId);
					await revokeLiveSessions(ctx, {
						userId: doc.userId,
						organizationId: doc.organizationId,
					});
				},
			},
		},
	},
);

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

const NO_EMAIL_PATHS: Record<string, AuthEmail["kind"]> = {
	"/request-password-reset": "reset",
	"/send-verification-email": "verify",
};

const sendAuthEmail = async (ctx: GenericCtx<DataModel>, email: AuthEmail) => {
	if (!("runMutation" in ctx)) {
		throw new Error("Account email requires a writable context");
	}
	try {
		await ctx.runMutation(internal.authEmail.send, email);
	} catch (error) {
		// Surface configuration problems to the user instead of a generic 500.
		if (error instanceof ConvexError && typeof error.data === "string") {
			throw new APIError("BAD_REQUEST", { message: error.data });
		}
		throw error;
	}
};

// The web app proxies /api/auth/* to Convex, so Better Auth lives on the
// app's own origin (SITE_URL): cookies stay first-party.
export const createAuth = (ctx: GenericCtx<DataModel>) => {
	const site = siteUrl();
	return betterAuth({
		...createAuthOptions(
			(email) => sendAuthEmail(ctx, email),
			async (userId) =>
				await ctx.runQuery(components.betterAuth.policy.isInstanceAdmin, {
					userId,
				}),
		),
		baseURL: site,
		trustedOrigins: [site],
		onAPIError: { errorURL: `${site}/login` },
		database: authComponent.adapter(ctx),
		databaseHooks: {
			user: {
				create: {
					before: async (user, context) => {
						if (context?.path !== "/sign-up/email") return;
						const body = context.body as
							| { invitationId?: unknown; setupToken?: unknown }
							| undefined;
						const policy = await ctx.runQuery(internal.authEmail.signupPolicy, {
							email: user.email,
							invitationId:
								typeof body?.invitationId === "string"
									? body.invitationId
									: undefined,
						});
						if (policy.refusal) {
							// Not FORBIDDEN: sign-up turns a 403 into a fake success.
							throw new APIError("BAD_REQUEST", policy.refusal);
						}
						if (policy.setup) {
							const token =
								typeof body?.setupToken === "string" ? body.setupToken : "";
							if (!token) {
								throw new APIError("BAD_REQUEST", {
									message: SETUP_LINK_REQUIRED,
									code: "SETUP_LINK_REQUIRED",
								});
							}
							if (!("runMutation" in ctx)) {
								throw new Error("Sign-up requires a writable context");
							}
							try {
								await ctx.runMutation(
									components.betterAuth.policy.reserveSetup,
									{
										token,
										email: user.email,
									},
								);
							} catch (error) {
								if (
									error instanceof ConvexError &&
									typeof error.data === "string"
								) {
									throw new APIError("BAD_REQUEST", {
										message: error.data,
										code: "SETUP_LINK_INVALID",
									});
								}
								throw error;
							}
						}
						if (policy.verified) {
							return { data: { ...user, emailVerified: true } };
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						const policy = await ctx.runQuery(internal.users.sessionPolicy, {
							userId: session.userId,
						});
						if (policy.deactivated) {
							throw new APIError("FORBIDDEN", {
								message: "This account has been deactivated",
								code: "ACCOUNT_DEACTIVATED",
							});
						}
						if (!session.activeOrganizationId && policy.defaultOrganizationId) {
							return {
								data: {
									...session,
									activeOrganizationId: policy.defaultOrganizationId,
								},
							};
						}
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (context) => {
				// Better Auth sends these in the background and answers success
				// either way; without email, say so up front instead (for every
				// address alike, so it reveals nothing about accounts).
				const unavailable = NO_EMAIL_PATHS[context.path];
				if (unavailable) {
					const { enabled } = await ctx.runQuery(api.email.status, {});
					if (!enabled) {
						throw new APIError("BAD_REQUEST", {
							message: NO_EMAIL_MESSAGES[unavailable],
							code: "EMAIL_UNAVAILABLE",
						});
					}
				}
				await enforceAuthRateLimit(
					ctx,
					context.path,
					context.body,
					context.headers,
				);
				// An unproven address (see unprovenEmails) doesn't reveal
				// invitations sent to it; their link is how the invitee joins.
				if (context.path === "/organization/list-user-invitations") {
					const session = await getSessionFromCtx(context);
					if (
						session &&
						(await ctx.runQuery(internal.users.emailUnproven, {
							userId: session.user.id,
							email: session.user.email,
						}))
					) {
						return context.json([]);
					}
				}
			}),
		},
	});
};

// The user of a live browser session, or undefined. An API key has no
// session, so nothing built on this answers one.
export const sessionUser = async (ctx: QueryCtx) => {
	const caller = await optionalCaller(ctx);
	if (!caller || caller.apiKey) return undefined;
	return await authComponent.safeGetAuthUser(ctx);
};

// Returns null instead of throwing: the query stays subscribed briefly after
// sign-out, and throwing there would unmount the app.
export const getCurrentUser = query({
	args: {},
	handler: async (ctx) => {
		return (await sessionUser(ctx)) ?? null;
	},
});
