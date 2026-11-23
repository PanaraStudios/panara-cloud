"use node";

import { generateKeyPairSync, randomInt } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import {
	fromBase64Url,
	type KeyMaterial,
	openSshPrivateKey,
	openSshPublicKey,
} from "./sshKeyFormat";

const COMMENT = "panara-cloud";

const generate = (type: "rsa" | "ed25519"): KeyMaterial => {
	if (type === "ed25519") {
		const { privateKey } = generateKeyPairSync("ed25519");
		const jwk = privateKey.export({ format: "jwk" });
		return {
			type,
			publicKey: fromBase64Url(jwk.x ?? ""),
			seed: fromBase64Url(jwk.d ?? ""),
		};
	}
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
	const jwk = privateKey.export({ format: "jwk" });
	const field = (value: string | undefined) => fromBase64Url(value ?? "");
	return {
		type,
		n: field(jwk.n),
		e: field(jwk.e),
		d: field(jwk.d),
		p: field(jwk.p),
		q: field(jwk.q),
		qi: field(jwk.qi),
	};
};

// Returns a fresh keypair for the "Add SSH Key"
// form to fill in (and offer as a download); nothing is stored until the
// form is submitted through `sshKeys.create`.
export const generateKeyPair = action({
	args: {
		organizationId: v.string(),
		type: v.optional(v.union(v.literal("rsa"), v.literal("ed25519"))),
	},
	handler: async (
		ctx,
		{ organizationId, type },
	): Promise<{ privateKey: string; publicKey: string }> => {
		await ctx.runQuery(internal.permissions.check, {
			organizationId,
			resource: "sshKeys",
			action: "read",
		});
		const key = generate(type ?? "rsa");
		return {
			publicKey: openSshPublicKey(key, COMMENT),
			privateKey: openSshPrivateKey(key, COMMENT, randomInt(2 ** 32)),
		};
	},
});

// Generates a keypair and stores it like `sshKeys.create`; the private key
// never leaves the backend. Returns the public key to add to servers or Git
// hosts.
export const generateSshKey = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		type: v.optional(v.union(v.literal("rsa"), v.literal("ed25519"))),
	},
	handler: async (
		ctx,
		{ organizationId, name, description, type },
	): Promise<{ sshKeyId: Id<"sshKeys">; publicKey: string }> => {
		await ctx.runQuery(internal.permissions.check, {
			organizationId,
			resource: "sshKeys",
			action: "create",
		});
		const key = generate(type ?? "rsa");
		const publicKey = openSshPublicKey(key, COMMENT);
		const privateKey = openSshPrivateKey(key, COMMENT, randomInt(2 ** 32));
		const sshKeyId: Id<"sshKeys"> = await ctx.runMutation(
			internal.sshKeys.insert,
			{
				organizationId,
				name: name.trim() || `${type ?? "rsa"} key`,
				description,
				publicKey,
				...(await encryptSecret(privateKey)),
			},
		);
		return { sshKeyId, publicKey };
	},
});
