import { components } from "../_generated/api";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireInstanceAdmin } from "../infra/access";
import { optionalCaller, requireUserId } from "../lib/access";

// The panel's one-time setup belongs to the instance administrator: the
// account that created the instance, while it still administers the root
// organization (the setup steps are instance settings only it may change).
const isSetupAdministrator = async (ctx: QueryCtx, userId: string) => {
	const created = await ctx.runQuery(
		components.betterAuth.policy.isInstanceAdmin,
		{ userId },
	);
	if (!created) return false;
	try {
		await requireInstanceAdmin(ctx);
		return true;
	} catch {
		return false;
	}
};

const completionOf = (ctx: QueryCtx, userId: string) =>
	ctx.db
		.query("onboardingCompletions")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.first();

// Whether the "Set up your panel" screen is due: once, for the instance
// administrator, until they finish or skip it.
export const status = query({
	args: {},
	handler: async (ctx) => {
		// The shell keeps rendering while a session rotates (e.g. after a
		// password change), so answer null instead of throwing.
		if ((await optionalCaller(ctx)) === null) return null;
		const userId = await requireUserId(ctx);
		if (!(await isSetupAdministrator(ctx, userId))) {
			return {
				isInstanceAdmin: false,
				shouldShowOnboarding: false,
				completedAt: null,
			};
		}
		const completion = await completionOf(ctx, userId);
		return {
			isInstanceAdmin: true,
			shouldShowOnboarding: completion === null,
			completedAt: completion?.completedAt ?? null,
		};
	},
});

export const complete = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		if (!(await isSetupAdministrator(ctx, userId))) return;
		if ((await completionOf(ctx, userId)) === null) {
			await ctx.db.insert("onboardingCompletions", {
				userId,
				completedAt: Date.now(),
			});
		}
	},
});
