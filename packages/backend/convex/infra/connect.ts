import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { permissionsForRole, requirePermission } from "../lib/permissions";
import { insertServer } from "../servers";
import { enqueueServerSetup } from "./setup";
import { isIp } from "./validation";

// The server "connect" flow: the UI generates a command
// (`curl -fsSL <panel>/api/connect/<token> | sudo bash`); the script it
// downloads authorizes a fresh SSH key for root and POSTs back, which
// registers the server under the address the request came from.
export const CONNECT_TOKEN_TTL_MS = 60 * 60 * 1000;
const EXPIRE_BATCH = 200;
const serverType = v.union(v.literal("deploy"), v.literal("build"));

const REGISTER_URL_PATTERN =
	/^https?:\/\/[A-Za-z0-9.:[\]-]+\/(api|infra)\/connect\/[A-Za-z0-9_-]+$/;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export const buildConnectScript = ({
	publicKey,
	registerUrl,
	setup,
}: {
	publicKey: string;
	registerUrl: string;
	setup: boolean;
}) => {
	const key = publicKey.trim();
	if (!REGISTER_URL_PATTERN.test(registerUrl)) {
		throw new Error("Invalid register URL");
	}
	if (!/^[A-Za-z0-9+/=@. -]+$/.test(key)) {
		throw new Error("Invalid public key");
	}
	const postUrl = setup ? `${registerUrl}?setup=true` : registerUrl;
	return `#!/usr/bin/env bash
set -euo pipefail
main() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this command as root (with sudo)." >&2
    exit 1
  fi
  local keys=/root/.ssh/authorized_keys
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  touch "$keys"
  chmod 600 "$keys"
  if [ -s "$keys" ] && [ -n "$(tail -c1 "$keys")" ]; then echo >> "$keys"; fi
  grep -qxF '${key}' "$keys" || echo '${key}' >> "$keys"
  restorecon -R /root/.ssh 2>/dev/null || true
  local body code
  body=$(mktemp)
  # IPv4 first: Panara Cloud saves the address this request comes from and SSHes to it.
  code=$(curl -4 -sSL --post301 --post302 --post303 -o "$body" -w '%{http_code}' --data '' '${postUrl}' 2>/dev/null) ||
    code=$(curl -sSL --post301 --post302 --post303 -o "$body" -w '%{http_code}' --data '' '${postUrl}') ||
    { echo "Could not reach Panara Cloud." >&2; rm -f "$body"; exit 1; }
  cat "$body"; echo
  rm -f "$body"
  [ "$code" = "200" ] || exit 1
}
main "$@"
`;
};

export const buildConnectErrorScript = (message: string) =>
	`#!/usr/bin/env bash
echo '${message.replace(/'/g, "")}' >&2
exit 1
`;

// Whoever sends these headers already holds the token, so spoofing them only
// mislabels their own server.
export const connectClientIp = (headers: Headers) => {
	const first = (name: string) =>
		headers.get(name)?.split(",")[0]?.trim() || undefined;
	const ip = (
		first("x-panara-cloud-client-ip") ||
		first("cf-connecting-ip") ||
		first("x-forwarded-for") ||
		first("x-real-ip") ||
		""
	).replace(/^::ffff:/, "");
	return isIp(ip) ? ip : null;
};

export const authorizeCreate = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"server",
			"create",
		);
		return { userId };
	},
});

export const store = internalMutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		publicKey: v.string(),
		privateKey: v.object({ iv: v.string(), ciphertext: v.string() }),
		tokenHash: v.string(),
		serverType,
		enableDockerCleanup: v.boolean(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"server",
			"create",
		);
		if (userId !== args.userId) throw new ConvexError("Unauthorized");
		const name = args.name.trim();
		if (!name || name.length > 100) {
			throw new ConvexError("Name must be 1 to 100 characters");
		}
		const description = args.description?.trim() || undefined;
		if (description && description.length > 200) {
			throw new ConvexError("Description is too long");
		}
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId: args.organizationId,
			name,
			description,
			publicKey: args.publicKey,
		});
		await ctx.db.insert("secrets", {
			organizationId: args.organizationId,
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			...args.privateKey,
		});
		const expiresAt = Date.now() + CONNECT_TOKEN_TTL_MS;
		await ctx.db.insert("serverConnectTokens", {
			organizationId: args.organizationId,
			tokenHash: args.tokenHash,
			sshKeyId,
			userId,
			expiresAt,
			serverType: args.serverType,
			enableDockerCleanup: args.enableDockerCleanup,
		});
		return { sshKeyId, expiresAt };
	},
});

// Connect status: the server registered by the command
// generated for this key, once it ran.
export const status = query({
	args: { sshKeyId: v.id("sshKeys") },
	handler: async (ctx, { sshKeyId }) => {
		const key = await ctx.db.get("sshKeys", sshKeyId);
		if (!key) return null;
		await requirePermission(ctx, key.organizationId, "server", "create");
		const token = await ctx.db
			.query("serverConnectTokens")
			.withIndex("by_sshKeyId", (q) => q.eq("sshKeyId", sshKeyId))
			.first();
		const server = token?.serverId
			? await ctx.db.get("servers", token.serverId)
			: null;
		return server
			? { serverId: server._id, name: server.name, ipAddress: server.ipAddress }
			: null;
	},
});

export const resolve = internalQuery({
	args: { tokenHash: v.string() },
	handler: async (ctx, { tokenHash }) => {
		const token = await ctx.db
			.query("serverConnectTokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique();
		if (!token) return null;
		const key = await ctx.db.get("sshKeys", token.sshKeyId);
		if (!key) return null;
		return {
			publicKey: key.publicKey,
			expiresAt: token.expiresAt,
			used: token.usedAt !== undefined,
		};
	},
});

const failure = (status: number, message: string) => ({ status, message });

export const register = internalMutation({
	args: {
		tokenHash: v.string(),
		ipAddress: v.union(v.string(), v.null()),
		setup: v.boolean(),
	},
	handler: async (ctx, { tokenHash, ipAddress, setup }) => {
		const token = await ctx.db
			.query("serverConnectTokens")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique();
		const key = token ? await ctx.db.get("sshKeys", token.sshKeyId) : null;
		if (!token || !key) {
			return failure(
				400,
				"This command is not valid. Generate a new one in Panara Cloud.",
			);
		}
		if (token.usedAt !== undefined) {
			return failure(409, "This command was already used.");
		}
		if (token.expiresAt < Date.now()) {
			return failure(
				410,
				"This command expired. Generate a new one in Panara Cloud.",
			);
		}
		if (!ipAddress || !isIp(ipAddress)) {
			return failure(400, "Could not detect this server's IP address.");
		}
		const membership = await ctx.db
			.query("memberships")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", token.organizationId).eq("userId", token.userId),
			)
			.unique();
		if (
			!membership ||
			membership.deactivated ||
			!permissionsForRole(membership.role).server.create
		) {
			return failure(
				403,
				"The user who generated this command can no longer add servers.",
			);
		}
		const serverId = await insertServer(ctx, token.organizationId, {
			name: key.name,
			description: key.description,
			ipAddress,
			port: 22,
			username: "root",
			sshKeyId: key._id,
			serverType: token.serverType,
			enableDockerCleanup: token.enableDockerCleanup,
		});
		const now = Date.now();
		await ctx.db.patch("serverConnectTokens", token._id, {
			usedAt: now,
			serverId,
		});
		await ctx.db.patch("sshKeys", key._id, { lastUsedAt: now });
		if (setup) {
			const server = await ctx.db.get("servers", serverId);
			await enqueueServerSetup(ctx, {
				organizationId: token.organizationId,
				userId: token.userId,
				partition: serverId,
				serverId,
				server,
			});
		}
		const name = key.name.replace(/\p{Cc}/gu, "");
		return {
			status: 200,
			message: `Server "${name}" is connected. ${
				setup
					? "Panara Cloud is installing Docker and the rest of its requirements now. Go back to Panara Cloud to follow the progress."
					: "Go back to Panara Cloud to complete the setup."
			}`,
		};
	},
});

// Tokens are useless once expired (the connect dialog stops polling too);
// the SSH key and the server they created stay.
export const expireTokens = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("serverConnectTokens")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
			.take(EXPIRE_BATCH);
		for (const token of expired) {
			await ctx.db.delete("serverConnectTokens", token._id);
		}
	},
});
