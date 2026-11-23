import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { tables } from "./generatedSchema";

const schema = defineSchema({
	...tables,
	// `banned` is the "Deactivated" status. It is deliberately not a
	// Better Auth field, so no auth endpoint can read or write it; only the
	// admin functions in users.ts set it, and the session-create hook in
	// auth.ts refuses sign-ins while it is set.
	user: defineTable({
		...tables.user.validator.fields,
		banned: v.optional(v.boolean()),
	})
		.index("email_name", ["email", "name"])
		.index("name", ["name"])
		.index("userId", ["userId"]),
	member: tables.member.index("organizationId_userId", [
		"organizationId",
		"userId",
	]),
	// The first account on the instance is its administrator; every later
	// account needs an invitation (see policy.ts).
	bootstrap: defineTable({
		key: v.literal("initial-account"),
		userId: v.string(),
	}).index("by_key", ["key"]),
	// The installer's one-time setup link (`install.sh setup-link`): only its
	// SHA-256 is stored. Creating the first account needs it (policy.ts).
	setupToken: defineTable({
		key: v.literal("setup"),
		tokenHash: v.string(),
		expiresAt: v.number(),
		// Set by a sign-up that presented the token, for the user-create
		// trigger to match; `userId` once that user row exists.
		email: v.optional(v.string()),
		reservedUntil: v.optional(v.number()),
		userId: v.optional(v.string()),
	}).index("by_key", ["key"]),
});

export default schema;
