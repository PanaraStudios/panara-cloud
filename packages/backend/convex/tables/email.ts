import { defineTable } from "convex/server";
import { v } from "convex/values";

export const emailProviderKind = v.union(
	v.literal("opensend"),
	v.literal("resend"),
);

export const emailTables = {
	// The instance's account-email provider (Settings → Email), one row keyed
	// "instance". The API key lives in `secrets` (kind "email.apiKey").
	emailProvider: defineTable({
		key: v.literal("instance"),
		provider: emailProviderKind,
		from: v.string(),
		baseUrl: v.optional(v.string()),
		apiKeyHint: v.string(),
		updatedAt: v.number(),
		updatedBy: v.string(),
		lastSentAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		lastErrorAt: v.optional(v.number()),
	}).index("by_key", ["key"]),
};
