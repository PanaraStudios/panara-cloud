import type { MutationCtx, QueryCtx } from "../_generated/server";

// See `unprovenEmails` in tables/core.ts.
export const markEmailUnproven = async (
	ctx: MutationCtx,
	userId: string,
	email: string,
	vouchedBy?: string,
) => {
	const existing = await ctx.db
		.query("unprovenEmails")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.unique();
	const row = { userId, email: email.trim().toLowerCase(), vouchedBy };
	if (existing) await ctx.db.replace("unprovenEmails", existing._id, row);
	else await ctx.db.insert("unprovenEmails", row);
};

// True while the user's current address is the unproven one.
export const isEmailUnproven = async (
	ctx: QueryCtx,
	userId: string,
	email: string,
) => {
	const row = await ctx.db
		.query("unprovenEmails")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.unique();
	return !!row && row.email === email.trim().toLowerCase();
};
