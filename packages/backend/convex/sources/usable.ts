import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { type QueryCtx, query } from "../_generated/server";
import { requireMember } from "../lib/access";
import { gitProviderType } from "../tables/sources";
import { canUseProvider } from "./access";
import { toPublic } from "./providers";
import { hasSecret, providerSecretKind } from "./secrets";

const MAX_PROVIDERS = 200;

// A provider can be picked as a
// service source once it holds the credentials its API calls need, whatever
// the `connected` flag says.
export const hasCredentials = async (
	ctx: QueryCtx,
	provider: Doc<"gitProviders">,
): Promise<boolean> => {
	const has = (field: Parameters<typeof providerSecretKind>[0]) =>
		hasSecret(ctx, providerSecretKind(field), provider._id);
	const { config } = provider;
	switch (config.type) {
		case "github":
			return (
				config.appId !== undefined &&
				!!config.installationId &&
				(await has("githubPrivateKey"))
			);
		case "gitlab":
			return await has("tokens");
		case "gitea":
			return (
				!!config.clientId &&
				(await has("clientSecret")) &&
				(await has("tokens"))
			);
		// Every Bitbucket provider is listed; one that names a credential
		// must still hold it.
		case "bitbucket":
			return config.authMode === "apiToken"
				? await has("apiToken")
				: config.authMode === "appPassword"
					? await has("appPassword")
					: true;
	}
};

// The providers a member may pick as a source on the service pages.
export const list = query({
	args: {
		organizationId: v.string(),
		providerType: v.optional(gitProviderType),
	},
	handler: async (ctx, { organizationId, providerType }) => {
		const { userId, role } = await requireMember(ctx, organizationId);
		const providers = await ctx.db
			.query("gitProviders")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_PROVIDERS);
		const usable = [];
		for (const provider of providers) {
			if (!canUseProvider(provider, userId, role)) continue;
			if (providerType && provider.providerType !== providerType) continue;
			if (await hasCredentials(ctx, provider)) {
				usable.push(toPublic(provider, userId));
			}
		}
		return usable;
	},
});
