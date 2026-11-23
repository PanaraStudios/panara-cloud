import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const GRANT_TTL_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 20;

export const issueUploadUrl = async (
	ctx: MutationCtx,
	userId: string,
	purpose: string,
): Promise<string> => {
	const now = Date.now();
	const expired = await ctx.db
		.query("uploadGrants")
		.withIndex("by_userId_and_purpose_and_issuedAt", (q) =>
			q
				.eq("userId", userId)
				.eq("purpose", purpose)
				.lt("issuedAt", now - GRANT_TTL_MS),
		)
		.take(PRUNE_BATCH);
	for (const grant of expired) await ctx.db.delete("uploadGrants", grant._id);
	await ctx.db.insert("uploadGrants", { userId, purpose, issuedAt: now });
	return await ctx.storage.generateUploadUrl();
};

// Convex doesn't tie an upload to whoever asked for its URL, so a storage id
// is accepted only from a user holding an unused upload URL issued before the
// file was stored, and stays bound to that user afterwards.
export const claimUpload = async (
	ctx: MutationCtx,
	userId: string,
	purpose: string,
	storageId: Id<"_storage">,
) => {
	const file = await ctx.db.system.get("_storage", storageId);
	if (!file) throw new ConvexError("Upload not found");
	const claim = await ctx.db
		.query("uploadClaims")
		.withIndex("by_storageId", (q) => q.eq("storageId", storageId))
		.unique();
	if (claim) {
		if (claim.userId !== userId || claim.purpose !== purpose) {
			throw new ConvexError("Upload not found");
		}
		return file;
	}
	const grant = await ctx.db
		.query("uploadGrants")
		.withIndex("by_userId_and_purpose_and_issuedAt", (q) =>
			q
				.eq("userId", userId)
				.eq("purpose", purpose)
				.gte("issuedAt", Date.now() - GRANT_TTL_MS)
				.lte("issuedAt", file._creationTime),
		)
		.first();
	if (!grant) throw new ConvexError("Upload not found");
	await ctx.db.delete("uploadGrants", grant._id);
	await ctx.db.insert("uploadClaims", { storageId, userId, purpose });
	return file;
};
