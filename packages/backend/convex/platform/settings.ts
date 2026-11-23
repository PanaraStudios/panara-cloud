import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../lib/access";
import { requirePermission } from "../lib/permissions";

// Organization-level settings outside auth. Instance-wide panel settings
// (server IP, Traefik, cleanup) belong to infra's webServerSettings.
export const get = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		const settings = await ctx.db
			.query("organizationSettings")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.unique();
		return {
			panelUrl: settings?.panelUrl ?? null,
			customAiProviders: settings?.customAiProviders ?? [],
		};
	},
});

export const update = mutation({
	args: {
		organizationId: v.string(),
		panelUrl: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, { organizationId, panelUrl }) => {
		await requirePermission(ctx, organizationId, "organization", "update");
		let normalized: string | undefined;
		if (panelUrl) {
			try {
				const url = new URL(panelUrl.trim());
				if (url.protocol !== "https:" && url.protocol !== "http:") throw 0;
				normalized = url.toString().replace(/\/+$/, "");
			} catch {
				throw new ConvexError("Panel URL must be an http(s) URL");
			}
		}
		const existing = await ctx.db
			.query("organizationSettings")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.unique();
		if (existing) {
			if (panelUrl !== undefined) {
				await ctx.db.patch("organizationSettings", existing._id, {
					panelUrl: normalized,
				});
			}
		} else {
			await ctx.db.insert("organizationSettings", {
				organizationId,
				panelUrl: normalized,
				customAiProviders: [],
			});
		}
	},
});

// The clock shown in the dashboard header. Queries are cached, so the client
// ticks forward from this reading instead of re-querying.
export const serverTime = query({
	args: {},
	handler: async () => ({
		time: Date.now(),
		timezone:
			process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
	}),
});
