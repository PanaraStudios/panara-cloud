import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { LOCAL_PARTITION } from "../tables/core";
import { decryptSecret } from "./crypto";

export type HostTarget =
	| { type: "local" }
	| {
			type: "ssh";
			serverId: string;
			host: string;
			port: number;
			username: string;
			privateKey: string;
			// Null until the agent first connects (trust on first use).
			hostKey: string | null;
	  };

// Resolves how the agent reaches a server (or the panel host itself),
// decrypting the SSH key. Only call from lease-guarded agent functions.
export const resolveHostTarget = async (
	ctx: QueryCtx,
	serverIdOrLocal: string | undefined,
): Promise<HostTarget> => {
	if (!serverIdOrLocal || serverIdOrLocal === LOCAL_PARTITION) {
		return { type: "local" };
	}
	const serverId = ctx.db.normalizeId("servers", serverIdOrLocal);
	const server = serverId ? await ctx.db.get("servers", serverId) : null;
	if (!server) throw new ConvexError("Server not found");
	if (!server.sshKeyId) throw new ConvexError("Server has no SSH key");
	const sshKeyId = server.sshKeyId;
	const secret = await ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", "sshPrivateKey").eq("ownerId", sshKeyId),
		)
		.unique();
	if (!secret) throw new ConvexError("SSH private key missing");
	return {
		type: "ssh",
		serverId: server._id,
		host: server.ipAddress,
		port: server.port,
		username: server.username,
		privateKey: await decryptSecret(secret),
		hostKey: server.sshHostKey ?? null,
	};
};
