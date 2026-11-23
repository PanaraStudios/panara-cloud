"use node";

import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { encryptSecret, sha256Hex } from "../lib/crypto";
import {
	fromBase64Url,
	type KeyMaterial,
	openSshPrivateKey,
	openSshPublicKey,
} from "../sources/sshKeyFormat";

const COMMENT = "panara-cloud";

const ed25519 = (): KeyMaterial => {
	const { privateKey } = generateKeyPairSync("ed25519");
	const jwk = privateKey.export({ format: "jwk" });
	return {
		type: "ed25519",
		publicKey: fromBase64Url(jwk.x ?? ""),
		seed: fromBase64Url(jwk.d ?? ""),
	};
};

// Generates the connect command: a new SSH key named after the
// server plus a single-use token valid for an hour. The UI turns the token
// into `curl -fsSL <panel>/api/connect/<token> | sudo bash`.
export const generateCommand = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		serverType: v.union(v.literal("deploy"), v.literal("build")),
		enableDockerCleanup: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ token: string; sshKeyId: Id<"sshKeys">; expiresAt: number }> => {
		const { userId } = await ctx.runQuery(
			internal.infra.connect.authorizeCreate,
			{
				organizationId: args.organizationId,
			},
		);
		const key = ed25519();
		const token = randomBytes(24).toString("base64url");
		const { sshKeyId, expiresAt } = await ctx.runMutation(
			internal.infra.connect.store,
			{
				organizationId: args.organizationId,
				userId,
				name: args.name,
				description: args.description,
				publicKey: openSshPublicKey(key, COMMENT),
				privateKey: await encryptSecret(
					openSshPrivateKey(key, COMMENT, randomInt(2 ** 32)),
				),
				tokenHash: await sha256Hex(token),
				serverType: args.serverType,
				enableDockerCleanup: args.enableDockerCleanup ?? false,
			},
		);
		return { token, sshKeyId, expiresAt };
	},
});
