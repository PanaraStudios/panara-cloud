import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	mutation,
	query,
} from "../_generated/server";
import { requireMember, requireUserId } from "../lib/access";
import { sha256Hex } from "../lib/crypto";
import {
	loadGrants,
	permissionsForMember,
	requirePermission,
} from "../lib/permissions";

export const API_KEY_PREFIX = "pnr_";
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SHOWN_RANDOM_LENGTH = 8;
export const MAX_API_KEY_LENGTH = 256;
const MAX_KEYS_PER_USER = 50;
const LAST_USED_RESOLUTION_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

const rateLimitPerMinute = () => {
	const configured = Number(process.env.API_RATE_LIMIT_PER_MINUTE);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_RATE_LIMIT_PER_MINUTE;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COUNT = 1_000_000_000;

const randomKey = (prefix: string): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `${prefix}${btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "")}`;
};

export const rateLimitInput = v.object({
	timeWindowMs: v.number(),
	max: v.number(),
});

export const requestLimitInput = v.object({
	remaining: v.number(),
	refillAmount: v.optional(v.number()),
	refillIntervalMs: v.optional(v.number()),
});

const checkInteger = (
	value: number,
	min: number,
	max: number,
	label: string,
) => {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ConvexError(
			`${label} must be a whole number from ${min} to ${max}`,
		);
	}
};

const checkLimits = (
	rateLimit: Infer<typeof rateLimitInput> | undefined,
	requestLimit: Infer<typeof requestLimitInput> | undefined,
) => {
	if (rateLimit) {
		checkInteger(rateLimit.timeWindowMs, 1000, 30 * DAY_MS, "Time window");
		checkInteger(rateLimit.max, 1, MAX_COUNT, "Maximum requests");
	}
	if (requestLimit) {
		checkInteger(requestLimit.remaining, 1, MAX_COUNT, "Total request limit");
		const { refillAmount, refillIntervalMs } = requestLimit;
		if ((refillAmount === undefined) !== (refillIntervalMs === undefined)) {
			throw new ConvexError(
				"Refill amount and refill interval must be set together",
			);
		}
		if (refillAmount !== undefined && refillIntervalMs !== undefined) {
			checkInteger(refillAmount, 1, MAX_COUNT, "Refill amount");
			checkInteger(refillIntervalMs, 60_000, 365 * DAY_MS, "Refill interval");
		}
	}
};

const publicKey = (key: Doc<"apiKeys">) => ({
	_id: key._id,
	_creationTime: key._creationTime,
	organizationId: key.organizationId,
	name: key.name,
	prefix: key.prefix,
	expiresAt: key.expiresAt,
	lastUsedAt: key.lastUsedAt,
	rateLimit: key.rateLimit,
	requestLimit: key.requestLimit,
});

// Generated in an action: mutations use a seeded PRNG, and the key must be
// unpredictable. The plaintext key is returned once and never stored.
// `prefix` (a custom prefix) is prepended verbatim, as in Better
// Auth's api-key plugin.
export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		expiresAt: v.optional(v.number()),
		prefix: v.optional(v.string()),
		rateLimit: v.optional(rateLimitInput),
		requestLimit: v.optional(requestLimitInput),
	},
	handler: async (
		ctx,
		{ organizationId, name, expiresAt, prefix, rateLimit, requestLimit },
	): Promise<{ apiKeyId: Id<"apiKeys">; key: string; prefix: string }> => {
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Name is required");
		if (expiresAt !== undefined && expiresAt <= Date.now()) {
			throw new ConvexError("Expiry must be in the future");
		}
		const keyPrefix = prefix?.trim() || API_KEY_PREFIX;
		if (!PREFIX_PATTERN.test(keyPrefix)) {
			throw new ConvexError(
				"Prefix must be 1-32 letters, digits, underscores or dashes",
			);
		}
		checkLimits(rateLimit, requestLimit);
		const key = randomKey(keyPrefix);
		const shown = key.slice(0, keyPrefix.length + SHOWN_RANDOM_LENGTH);
		const apiKeyId: Id<"apiKeys"> = await ctx.runMutation(
			internal.platform.apiKeys.insert,
			{
				organizationId,
				name: trimmed,
				prefix: shown,
				hash: await sha256Hex(key),
				expiresAt,
				rateLimit,
				requestLimit,
			},
		);
		return { apiKeyId, key, prefix: shown };
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		prefix: v.string(),
		hash: v.string(),
		expiresAt: v.optional(v.number()),
		rateLimit: v.optional(rateLimitInput),
		requestLimit: v.optional(requestLimitInput),
	},
	handler: async (ctx, args) => {
		checkLimits(args.rateLimit, args.requestLimit);
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"api",
			"read",
		);
		const existing = await ctx.db
			.query("apiKeys")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", args.organizationId).eq("userId", userId),
			)
			.take(MAX_KEYS_PER_USER);
		if (existing.length >= MAX_KEYS_PER_USER) {
			throw new ConvexError("API key limit reached; revoke an unused key");
		}
		return await ctx.db.insert("apiKeys", { ...args, userId });
	},
});

// The caller's own keys in an organization.
export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requireMember(ctx, organizationId);
		const keys = await ctx.db
			.query("apiKeys")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", organizationId).eq("userId", userId),
			)
			.take(MAX_KEYS_PER_USER);
		return keys.map(publicKey);
	},
});

const MAX_LISTED_ORGANIZATIONS = 100;

// The caller's keys across every organization they belong to (the profile
// page lists them all, each scoped to its organization).
export const listMine = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const memberships = await ctx.db
			.query("memberships")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.take(MAX_LISTED_ORGANIZATIONS);
		const perOrganization = await Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("apiKeys")
					.withIndex("by_organizationId_and_userId", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("userId", userId),
					)
					.take(MAX_KEYS_PER_USER),
			),
		);
		return perOrganization
			.flat()
			.sort((a, b) => b._creationTime - a._creationTime)
			.map(publicKey);
	},
});

// Owners revoke their own keys; org admins may revoke anyone's.
export const revoke = mutation({
	args: { apiKeyId: v.id("apiKeys") },
	handler: async (ctx, { apiKeyId }) => {
		const key = await ctx.db.get("apiKeys", apiKeyId);
		if (!key) return;
		const userId = await requireUserId(ctx);
		if (key.userId !== userId) {
			await requireMember(ctx, key.organizationId, "admin");
		} else {
			await requireMember(ctx, key.organizationId);
		}
		await ctx.db.delete("apiKeys", apiKeyId);
		const limit = await ctx.db
			.query("apiRateLimits")
			.withIndex("by_key", (q) => q.eq("key", apiKeyId))
			.unique();
		if (limit) await ctx.db.delete("apiRateLimits", limit._id);
	},
});

export type ApiKeyAuthResult =
	| {
			ok: true;
			apiKeyId: Id<"apiKeys">;
			userId: string;
			organizationId: string;
			role: "owner" | "admin" | "member";
	  }
	| { ok: false; status: 401 | 403 | 429; error: string; retryAfter?: number };

// Verifies a hashed key, applies the per-key rate limit and records usage, in
// one transaction. Concurrent requests for a key serialize on its counter
// document, so the fixed window never loses counts.
export const authenticate = internalMutation({
	args: { hash: v.string() },
	handler: async (ctx, { hash }): Promise<ApiKeyAuthResult> => {
		const key = await ctx.db
			.query("apiKeys")
			.withIndex("by_hash", (q) => q.eq("hash", hash))
			.unique();
		const now = Date.now();
		if (!key) return { ok: false, status: 401, error: "Invalid API key" };
		if (key.expiresAt !== undefined && key.expiresAt <= now) {
			return { ok: false, status: 401, error: "API key expired" };
		}
		const membership = await ctx.db
			.query("memberships")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", key.organizationId).eq("userId", key.userId),
			)
			.unique();
		if (!membership) {
			return {
				ok: false,
				status: 403,
				error: "API key owner is no longer a member of this organization",
			};
		}
		if (membership.deactivated) {
			return {
				ok: false,
				status: 403,
				error: "API key owner has been deactivated",
			};
		}
		if (membership.role === "member") {
			const grants = await loadGrants(ctx, key.organizationId, key.userId);
			if (!permissionsForMember("member", grants).api.read) {
				return {
					ok: false,
					status: 403,
					error: "API key owner has no access to the API",
				};
			}
		}

		const counter = await ctx.db
			.query("apiRateLimits")
			.withIndex("by_key", (q) => q.eq("key", key._id))
			.unique();

		let remaining: number | undefined;
		let lastRefillAt: number | undefined;
		if (key.requestLimit) {
			remaining = counter?.remaining ?? key.requestLimit.remaining;
			lastRefillAt = counter?.lastRefillAt ?? key._creationTime;
			const { refillAmount, refillIntervalMs } = key.requestLimit;
			if (
				refillAmount !== undefined &&
				refillIntervalMs !== undefined &&
				now - lastRefillAt >= refillIntervalMs
			) {
				remaining = refillAmount;
				lastRefillAt = now;
			}
			if (remaining <= 0) {
				return { ok: false, status: 429, error: "Usage limit exceeded" };
			}
		}

		const windowMs = key.rateLimit?.timeWindowMs ?? RATE_LIMIT_WINDOW_MS;
		const limit = key.rateLimit?.max ?? rateLimitPerMinute();
		const windowOpen = counter !== null && now - counter.windowStart < windowMs;
		if (windowOpen && counter.count >= limit) {
			return {
				ok: false,
				status: 429,
				error: "Rate limit exceeded",
				retryAfter: Math.ceil((counter.windowStart + windowMs - now) / 1000),
			};
		}
		const usage = {
			windowStart: windowOpen ? counter.windowStart : now,
			count: windowOpen ? counter.count + 1 : 1,
			...(remaining !== undefined
				? { remaining: remaining - 1, lastRefillAt }
				: {}),
		};
		if (counter) {
			await ctx.db.patch("apiRateLimits", counter._id, usage);
		} else {
			await ctx.db.insert("apiRateLimits", { key: key._id, ...usage });
		}

		if (
			key.lastUsedAt === undefined ||
			now - key.lastUsedAt >= LAST_USED_RESOLUTION_MS
		) {
			await ctx.db.patch("apiKeys", key._id, { lastUsedAt: now });
		}
		return {
			ok: true,
			apiKeyId: key._id,
			userId: key.userId,
			organizationId: key.organizationId,
			role: membership.role,
		};
	},
});
