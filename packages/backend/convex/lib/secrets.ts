import type { MutationCtx, QueryCtx } from "../_generated/server";
import { decryptSecret } from "./crypto";

// Helpers for the `secrets` table. Encrypt with `encryptSecret` in an action,
// then pass `{ iv, ciphertext }` to a mutation that calls `putSecret`.
export const putSecret = async (
	ctx: MutationCtx,
	secret: {
		organizationId: string;
		kind: string;
		ownerId: string;
		iv: string;
		ciphertext: string;
	},
) => {
	const existing = await ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", secret.kind).eq("ownerId", secret.ownerId),
		)
		.unique();
	if (existing) {
		await ctx.db.patch("secrets", existing._id, {
			iv: secret.iv,
			ciphertext: secret.ciphertext,
		});
	} else {
		await ctx.db.insert("secrets", secret);
	}
};

export const readSecret = async (
	ctx: QueryCtx,
	kind: string,
	ownerId: string,
): Promise<string | null> => {
	const secret = await ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", kind).eq("ownerId", ownerId),
		)
		.unique();
	return secret ? await decryptSecret(secret) : null;
};

export const deleteSecret = async (
	ctx: MutationCtx,
	kind: string,
	ownerId: string,
) => {
	const secret = await ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", kind).eq("ownerId", ownerId),
		)
		.unique();
	if (secret) await ctx.db.delete("secrets", secret._id);
};
