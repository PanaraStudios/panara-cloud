import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { decryptSecret, encryptSecret } from "../lib/crypto";

export const providerSecretField = v.union(
	v.literal("githubPrivateKey"),
	v.literal("githubClientSecret"),
	v.literal("githubWebhookSecret"),
	v.literal("clientSecret"),
	v.literal("appPassword"),
	v.literal("apiToken"),
	v.literal("tokens"),
);

export type ProviderSecretField = typeof providerSecretField.type;

export const PROVIDER_SECRET_FIELDS: ProviderSecretField[] = [
	"githubPrivateKey",
	"githubClientSecret",
	"githubWebhookSecret",
	"clientSecret",
	"appPassword",
	"apiToken",
	"tokens",
];

export const encryptedValue = v.object({
	iv: v.string(),
	ciphertext: v.string(),
});

export const encryptedProviderSecret = v.object({
	field: providerSecretField,
	// null deletes the stored value.
	value: v.union(encryptedValue, v.null()),
});

export type OAuthTokens = { accessToken: string; refreshToken?: string };

export type ProviderSecrets = Partial<
	Record<Exclude<ProviderSecretField, "tokens">, string>
> & { tokens?: OAuthTokens };

export const providerSecretKind = (field: ProviderSecretField) =>
	`sources.gitProvider.${field}`;

export const REGISTRY_PASSWORD_KIND = "sources.registry.password";
export const REGISTRY_TEST_PASSWORD_KIND = "sources.registryTest.password";

const findSecret = (ctx: QueryCtx, kind: string, ownerId: string) =>
	ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", kind).eq("ownerId", ownerId),
		)
		.unique();

export const readSecret = async (
	ctx: QueryCtx,
	kind: string,
	ownerId: string,
): Promise<string | null> => {
	const secret = await findSecret(ctx, kind, ownerId);
	return secret ? await decryptSecret(secret) : null;
};

export const writeSecret = async (
	ctx: MutationCtx,
	secret: {
		organizationId: string;
		kind: string;
		ownerId: string;
		value: { iv: string; ciphertext: string } | null;
	},
) => {
	const existing = await findSecret(ctx, secret.kind, secret.ownerId);
	if (!secret.value) {
		if (existing) await ctx.db.delete("secrets", existing._id);
		return;
	}
	if (existing) {
		await ctx.db.patch("secrets", existing._id, secret.value);
	} else {
		await ctx.db.insert("secrets", {
			organizationId: secret.organizationId,
			kind: secret.kind,
			ownerId: secret.ownerId,
			...secret.value,
		});
	}
};

export const deleteSecret = async (
	ctx: MutationCtx,
	kind: string,
	ownerId: string,
) => {
	const existing = await findSecret(ctx, kind, ownerId);
	if (existing) await ctx.db.delete("secrets", existing._id);
};

export const hasSecret = async (
	ctx: QueryCtx,
	kind: string,
	ownerId: string,
): Promise<boolean> => (await findSecret(ctx, kind, ownerId)) !== null;

export const readProviderSecrets = async (
	ctx: QueryCtx,
	gitProviderId: Id<"gitProviders">,
): Promise<ProviderSecrets> => {
	const result: ProviderSecrets = {};
	for (const field of PROVIDER_SECRET_FIELDS) {
		const value = await readSecret(
			ctx,
			providerSecretKind(field),
			gitProviderId,
		);
		if (value === null) continue;
		if (field === "tokens") {
			result.tokens = JSON.parse(value) as OAuthTokens;
		} else {
			result[field] = value;
		}
	}
	return result;
};

export const writeProviderSecrets = async (
	ctx: MutationCtx,
	organizationId: string,
	gitProviderId: Id<"gitProviders">,
	secrets: (typeof encryptedProviderSecret.type)[],
) => {
	for (const secret of secrets) {
		await writeSecret(ctx, {
			organizationId,
			kind: providerSecretKind(secret.field),
			ownerId: gitProviderId,
			value: secret.value,
		});
	}
};

export const deleteProviderSecrets = async (
	ctx: MutationCtx,
	gitProviderId: Id<"gitProviders">,
) => {
	for (const field of PROVIDER_SECRET_FIELDS) {
		await deleteSecret(ctx, providerSecretKind(field), gitProviderId);
	}
};

// Call from actions only (see encryptSecret). Undefined fields are left as
// they are, null clears them, and empty strings are treated as "unchanged" so
// edit forms can leave secret inputs blank.
export const encryptProviderSecrets = async (
	values: Partial<Record<ProviderSecretField, string | null | undefined>>,
): Promise<(typeof encryptedProviderSecret.type)[]> => {
	const result: (typeof encryptedProviderSecret.type)[] = [];
	for (const field of PROVIDER_SECRET_FIELDS) {
		const value = values[field];
		if (value === undefined || value === "") continue;
		result.push({
			field,
			value: value === null ? null : await encryptSecret(value),
		});
	}
	return result;
};
