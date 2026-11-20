import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	type ActionCtx,
	internalMutation,
	type MutationCtx,
} from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import { providerFetch } from "../platform/lib/fetch";
import type { GitProviderConfig } from "../tables/sources";
import {
	encryptedValue,
	type OAuthTokens,
	type ProviderSecrets,
	providerSecretKind,
	writeSecret,
} from "./secrets";
import { splitBasicAuth } from "./urls";

const LOCK_MS = 30_000;
const WAIT_STEP_MS = 500;
const MAX_WAIT_STEPS = 80;

// Refresh this long before expiry so a token handed to a clone doesn't
// expire mid-flight.
const marginSeconds = (type: GitProviderConfig["type"]) =>
	type === "gitea" ? 300 : 120;

const tokenRow = (ctx: MutationCtx, gitProviderId: Id<"gitProviders">) =>
	ctx.db
		.query("gitProviderTokens")
		.withIndex("by_gitProviderId", (q) => q.eq("gitProviderId", gitProviderId))
		.unique();

const storeTokenSecret = async (
	ctx: MutationCtx,
	provider: Doc<"gitProviders">,
	tokens: { iv: string; ciphertext: string },
	expiresAt: number | undefined,
	row: Doc<"gitProviderTokens"> | null,
) => {
	await writeSecret(ctx, {
		organizationId: provider.organizationId,
		kind: providerSecretKind("tokens"),
		ownerId: provider._id,
		value: tokens,
	});
	const fields = {
		expiresAt,
		version: (row?.version ?? 0) + 1,
		lockId: undefined,
		lockExpiresAt: undefined,
	};
	if (row) {
		await ctx.db.patch("gitProviderTokens", row._id, fields);
	} else {
		await ctx.db.insert("gitProviderTokens", {
			organizationId: provider.organizationId,
			gitProviderId: provider._id,
			...fields,
		});
	}
};

// Decides, transactionally, whether the caller may use the stored access
// token, must wait for another caller's refresh, or owns the refresh.
export const beginTokenUse = internalMutation({
	args: { gitProviderId: v.id("gitProviders") },
	handler: async (ctx, { gitProviderId }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (!provider) throw new ConvexError("Git provider not found");
		const row = await tokenRow(ctx, gitProviderId);
		if (!row) throw new ConvexError(`${provider.name} is not authorized yet`);
		const now = Date.now();
		if (
			row.expiresAt === undefined ||
			row.expiresAt * 1000 > now + marginSeconds(provider.providerType) * 1000
		) {
			return { status: "fresh" as const };
		}
		if (row.lockId && (row.lockExpiresAt ?? 0) > now) {
			return { status: "wait" as const };
		}
		const lockId = crypto.randomUUID();
		await ctx.db.patch("gitProviderTokens", row._id, {
			lockId,
			lockExpiresAt: now + LOCK_MS,
		});
		return { status: "refresh" as const, lockId, version: row.version };
	},
});

export const completeRefresh = internalMutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		lockId: v.string(),
		version: v.number(),
		tokens: encryptedValue,
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const provider = await ctx.db.get("gitProviders", args.gitProviderId);
		const row = await tokenRow(ctx, args.gitProviderId);
		if (!provider || !row) return false;
		// If the lock expired but nobody stored newer tokens, ours are still the
		// only valid ones: the old refresh token was spent getting them.
		if (row.lockId !== args.lockId && row.version !== args.version) {
			return false;
		}
		await storeTokenSecret(ctx, provider, args.tokens, args.expiresAt, row);
		return true;
	},
});

export const releaseRefresh = internalMutation({
	args: { gitProviderId: v.id("gitProviders"), lockId: v.string() },
	handler: async (ctx, { gitProviderId, lockId }) => {
		const row = await tokenRow(ctx, gitProviderId);
		if (row?.lockId === lockId) {
			await ctx.db.patch("gitProviderTokens", row._id, {
				lockId: undefined,
				lockExpiresAt: undefined,
			});
		}
	},
});

// Tokens from an OAuth authorization-code exchange.
export const storeAuthorizedTokens = internalMutation({
	args: {
		gitProviderId: v.id("gitProviders"),
		tokens: encryptedValue,
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, { gitProviderId, tokens, expiresAt }) => {
		const provider = await ctx.db.get("gitProviders", gitProviderId);
		if (!provider) throw new ConvexError("Git provider not found");
		await storeTokenSecret(
			ctx,
			provider,
			tokens,
			expiresAt,
			await tokenRow(ctx, gitProviderId),
		);
		await ctx.db.patch("gitProviders", gitProviderId, { connected: true });
	},
});

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
};

const tokenEndpoint = (config: GitProviderConfig) => {
	if (config.type === "gitlab") {
		const { url, authorization } = splitBasicAuth(
			config.internalUrl || config.gitlabUrl,
		);
		return { url: `${url}/oauth/token`, authorization };
	}
	if (config.type === "gitea") {
		const { url, authorization } = splitBasicAuth(
			config.internalUrl || config.giteaUrl,
		);
		return { url: `${url}/login/oauth/access_token`, authorization };
	}
	throw new ConvexError("This provider does not use OAuth tokens");
};

const clientId = (config: GitProviderConfig) =>
	config.type === "gitlab"
		? config.applicationId
		: config.type === "gitea"
			? config.clientId
			: undefined;

export const requestToken = async (
	config: GitProviderConfig,
	secrets: ProviderSecrets,
	grant:
		| { grant_type: "authorization_code"; code: string; redirect_uri: string }
		| { grant_type: "refresh_token"; refresh_token: string },
): Promise<{ tokens: OAuthTokens; expiresAt?: number }> => {
	const id = clientId(config);
	if (!id || !secrets.clientSecret) {
		throw new ConvexError("OAuth application id and secret are required");
	}
	const { url, authorization } = tokenEndpoint(config);
	const response = await providerFetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			...(authorization ? { Authorization: authorization } : {}),
		},
		body: new URLSearchParams({
			client_id: id,
			client_secret: secrets.clientSecret,
			...grant,
		}),
	});
	if (!response.ok) {
		throw new ConvexError(
			`Token request failed: ${response.status} ${response.statusText}`,
		);
	}
	const data = (await response.json()) as TokenResponse;
	if (!data.access_token) {
		throw new ConvexError("Token response did not include an access token");
	}
	return {
		tokens: {
			accessToken: data.access_token,
			refreshToken:
				data.refresh_token ??
				(grant.grant_type === "refresh_token"
					? grant.refresh_token
					: undefined),
		},
		expiresAt: data.expires_in
			? Math.floor(Date.now() / 1000) + data.expires_in
			: undefined,
	};
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A valid access token for a GitLab or Gitea provider, refreshing it at most
// once across concurrent callers. Call only after authorizing the caller.
export const getAccessToken = async (
	ctx: ActionCtx,
	gitProviderId: Id<"gitProviders">,
): Promise<string> => {
	for (let step = 0; step < MAX_WAIT_STEPS; step++) {
		const state = await ctx.runMutation(internal.sources.tokens.beginTokenUse, {
			gitProviderId,
		});
		if (state.status === "wait") {
			await sleep(WAIT_STEP_MS);
			continue;
		}
		const { provider, secrets } = await ctx.runQuery(
			internal.sources.providers.forSystem,
			{ gitProviderId },
		);
		const current = secrets.tokens;
		if (!current) {
			throw new ConvexError(`${provider.name} is not authorized yet`);
		}
		if (state.status === "fresh") return current.accessToken;

		const release = () =>
			ctx.runMutation(internal.sources.tokens.releaseRefresh, {
				gitProviderId,
				lockId: state.lockId,
			});
		// Gitea without refresh credentials keeps using its access token.
		if (
			provider.config.type === "gitea" &&
			(!current.refreshToken || !secrets.clientSecret)
		) {
			await release();
			return current.accessToken;
		}
		if (!current.refreshToken) {
			await release();
			throw new ConvexError(
				`${provider.name} has no refresh token; reconnect it`,
			);
		}
		let refreshed: Awaited<ReturnType<typeof requestToken>>;
		try {
			refreshed = await requestToken(provider.config, secrets, {
				grant_type: "refresh_token",
				refresh_token: current.refreshToken,
			});
		} catch (error) {
			await release();
			if (provider.config.type === "gitea") return current.accessToken;
			throw error;
		}
		await ctx.runMutation(internal.sources.tokens.completeRefresh, {
			gitProviderId,
			lockId: state.lockId,
			version: state.version,
			tokens: await encryptSecret(JSON.stringify(refreshed.tokens)),
			expiresAt: refreshed.expiresAt,
		});
		return refreshed.tokens.accessToken;
	}
	throw new ConvexError("Timed out waiting for a token refresh");
};
