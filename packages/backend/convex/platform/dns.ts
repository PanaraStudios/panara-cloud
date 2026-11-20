import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requirePermission } from "../lib/permissions";
import { dnsProviderType } from "../tables/platform";
import { DNS_SPECS } from "./lib/dnsClients";
import { assertProviderName, maskConfig } from "./lib/providerConfig";
import { deleteSecret, readSecretFields, writeSecret } from "./lib/secrets";

const dnsAction = v.union(
	v.literal("read"),
	v.literal("create"),
	v.literal("update"),
	v.literal("delete"),
);

export const DNS_SECRET_KIND = "platform.dnsProvider";
const MAX_PROVIDERS = 200;

const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const toPublic = (provider: Doc<"dnsProviders">) => ({
	...provider,
	config: maskConfig(DNS_SPECS[provider.providerType], provider.config),
});

const assertNameAvailable = async (
	ctx: QueryCtx,
	organizationId: string,
	name: string,
	exceptId?: Id<"dnsProviders">,
) => {
	assertProviderName(name);
	const existing = await ctx.db
		.query("dnsProviders")
		.withIndex("by_organizationId_and_name", (q) =>
			q.eq("organizationId", organizationId).eq("name", name),
		)
		.unique();
	if (existing && existing._id !== exceptId) {
		throw new ConvexError(
			`A DNS provider named "${name}" already exists in this organization`,
		);
	}
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "dnsProvider", "read");
		const providers = await ctx.db
			.query("dnsProviders")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROVIDERS);
		return providers.map(toPublic);
	},
});

// Takes the raw id from the URL: a malformed one is "not found", not an error.
export const get = query({
	args: { dnsProviderId: v.string() },
	handler: async (ctx, args) => {
		const dnsProviderId = ctx.db.normalizeId(
			"dnsProviders",
			args.dnsProviderId,
		);
		const provider = dnsProviderId
			? await ctx.db.get("dnsProviders", dnsProviderId)
			: null;
		if (!provider) return null;
		await requirePermission(
			ctx,
			provider.organizationId,
			"dnsProvider",
			"read",
		);
		return toPublic(provider);
	},
});

export const remove = mutation({
	args: { dnsProviderId: v.id("dnsProviders") },
	handler: async (ctx, { dnsProviderId }) => {
		const provider = await ctx.db.get("dnsProviders", dnsProviderId);
		if (!provider) return;
		await requirePermission(
			ctx,
			provider.organizationId,
			"dnsProvider",
			"delete",
		);
		await deleteSecret(ctx, DNS_SECRET_KIND, dnsProviderId);
		await ctx.db.delete("dnsProviders", dnsProviderId);
	},
});

export const authorize = internalQuery({
	args: { organizationId: v.string(), action: dnsAction },
	handler: async (ctx, { organizationId, action }) => {
		await requirePermission(ctx, organizationId, "dnsProvider", action);
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		providerType: dnsProviderType,
		config: v.record(v.string(), v.string()),
		secret: encrypted,
	},
	handler: async (ctx, { secret, ...provider }) => {
		await requirePermission(
			ctx,
			provider.organizationId,
			"dnsProvider",
			"create",
		);
		await assertNameAvailable(ctx, provider.organizationId, provider.name);
		const dnsProviderId = await ctx.db.insert("dnsProviders", provider);
		await writeSecret(ctx, {
			organizationId: provider.organizationId,
			kind: DNS_SECRET_KIND,
			ownerId: dnsProviderId,
			secret,
		});
		return dnsProviderId;
	},
});

export const patch = internalMutation({
	args: {
		dnsProviderId: v.id("dnsProviders"),
		name: v.string(),
		providerType: dnsProviderType,
		config: v.record(v.string(), v.string()),
		secret: encrypted,
	},
	handler: async (ctx, { dnsProviderId, secret, ...fields }) => {
		const provider = await ctx.db.get("dnsProviders", dnsProviderId);
		if (!provider) throw new ConvexError("DNS provider not found");
		await requirePermission(
			ctx,
			provider.organizationId,
			"dnsProvider",
			"update",
		);
		await assertNameAvailable(
			ctx,
			provider.organizationId,
			fields.name,
			dnsProviderId,
		);
		await ctx.db.replace("dnsProviders", dnsProviderId, {
			organizationId: provider.organizationId,
			...fields,
		});
		await writeSecret(ctx, {
			organizationId: provider.organizationId,
			kind: DNS_SECRET_KIND,
			ownerId: dnsProviderId,
			secret,
		});
	},
});

const withCredentials = async (
	ctx: QueryCtx,
	provider: Doc<"dnsProviders">,
) => ({
	_id: provider._id,
	organizationId: provider.organizationId,
	name: provider.name,
	providerType: provider.providerType,
	public: Object.fromEntries(
		Object.entries(provider.config).map(([k, value]) => [k, String(value)]),
	),
	secret: (await readSecretFields(ctx, DNS_SECRET_KIND, provider._id)) ?? {},
});

export const getWithCredentials = internalQuery({
	args: { dnsProviderId: v.id("dnsProviders"), action: dnsAction },
	handler: async (ctx, { dnsProviderId, action }) => {
		const provider = await ctx.db.get("dnsProviders", dnsProviderId);
		if (!provider) throw new ConvexError("DNS provider not found");
		await requirePermission(
			ctx,
			provider.organizationId,
			"dnsProvider",
			action,
		);
		return await withCredentials(ctx, provider);
	},
});

// For internal callers (routing/domains); the organization bounds the lookup.
export const loadForOrganization = internalQuery({
	args: { organizationId: v.string(), dnsProviderId: v.id("dnsProviders") },
	handler: async (ctx, { organizationId, dnsProviderId }) => {
		const provider = await ctx.db.get("dnsProviders", dnsProviderId);
		if (!provider || provider.organizationId !== organizationId) {
			throw new ConvexError("DNS provider not found");
		}
		return await withCredentials(ctx, provider);
	},
});
