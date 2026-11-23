import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { decryptSecret, encryptSecret } from "../../lib/crypto";

export type EncryptedSecret = { iv: string; ciphertext: string };
export type SecretFields = Record<string, string>;

// Call from actions only (see encryptSecret).
export const encryptFields = (fields: SecretFields): Promise<EncryptedSecret> =>
	encryptSecret(JSON.stringify(fields));

const findSecret = (ctx: QueryCtx, kind: string, ownerId: string) =>
	ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", kind).eq("ownerId", ownerId),
		)
		.unique();

// Only call from internal or lease-guarded functions.
export const readSecretFields = async (
	ctx: QueryCtx,
	kind: string,
	ownerId: string,
): Promise<SecretFields | null> => {
	const secret = await findSecret(ctx, kind, ownerId);
	if (!secret) return null;
	return JSON.parse(await decryptSecret(secret)) as SecretFields;
};

export const hasSecret = async (
	ctx: QueryCtx,
	kind: string,
	ownerId: string,
): Promise<boolean> => (await findSecret(ctx, kind, ownerId)) !== null;

export const writeSecret = async (
	ctx: MutationCtx,
	args: {
		organizationId: string;
		kind: string;
		ownerId: string;
		secret: EncryptedSecret;
	},
) => {
	const existing = await findSecret(ctx, args.kind, args.ownerId);
	if (existing) {
		await ctx.db.patch("secrets", existing._id, args.secret);
	} else {
		await ctx.db.insert("secrets", {
			organizationId: args.organizationId,
			kind: args.kind,
			ownerId: args.ownerId,
			...args.secret,
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
