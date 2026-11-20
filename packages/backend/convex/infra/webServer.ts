import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireUserId } from "../lib/access";
import { encryptSecret } from "../lib/crypto";
import { requirePermission } from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";
import { certificateType, traefikPort } from "../tables/infra";
import {
	type HostScope,
	requireHostAccess,
	requireInstanceAdmin,
} from "./access";
import { enqueueHostJob, enqueueOp, traefikGroup } from "./hostJobs";
import { isIp, normalizeHost, validatePort } from "./validation";

export const TRAEFIK_ENV_SECRET = "infra.traefikEnv";
const MAX_ENV_LENGTH = 64 * 1024;
const MAX_TRAEFIK_FILE = 512 * 1024;
const RESERVED_TRAEFIK_PORTS = new Set([80, 443, 8080]);

export const DEFAULT_WEB_SERVER_SETTINGS = {
	key: "instance" as const,
	https: false,
	certificateType: "none" as const,
	enableDockerCleanup: true,
	cleanupCacheApplications: false,
	cleanupCacheOnPreviews: false,
	cleanupCacheOnCompose: false,
};

export const loadWebServerSettings = async (ctx: QueryCtx) =>
	(await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique()) ?? null;

const upsertWebServerSettings = async (
	ctx: MutationCtx,
	fields: Partial<Omit<Doc<"webServerSettings">, "_id" | "_creationTime">>,
) => {
	const current = await loadWebServerSettings(ctx);
	if (current) {
		await ctx.db.patch("webServerSettings", current._id, fields);
	} else {
		await ctx.db.insert("webServerSettings", {
			...DEFAULT_WEB_SERVER_SETTINGS,
			...fields,
		});
	}
};

// Readable by any signed-in user (DNS instructions need serverIp); it holds
// no secrets.
export const get = query({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx);
		const settings = await loadWebServerSettings(ctx);
		return (
			settings ?? {
				...DEFAULT_WEB_SERVER_SETTINGS,
				serverIp: undefined as string | undefined,
				host: undefined as string | undefined,
				letsEncryptEmail: undefined as string | undefined,
				publicIp: undefined as string | undefined,
				publicIpCheckedAt: undefined as number | undefined,
			}
		);
	},
});

export const isInstanceAdmin = query({
	args: {},
	handler: async (ctx) => {
		try {
			await requireInstanceAdmin(ctx);
			return true;
		} catch {
			return false;
		}
	},
});

// Assigns the panel's domain: routes the panel through Traefik on the
// panel host and sets the Let's Encrypt account email.
export const assignDomain = mutation({
	args: {
		host: v.optional(v.string()),
		https: v.boolean(),
		certificateType,
		letsEncryptEmail: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { userId, organizationId } = await requireInstanceAdmin(ctx);
		const host = args.host ? normalizeHost(args.host) : undefined;
		const email = args.letsEncryptEmail?.trim() || undefined;
		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new ConvexError("Invalid email address");
		}
		if (args.certificateType === "letsencrypt" && args.https && !email) {
			const current = await loadWebServerSettings(ctx);
			if (!current?.letsEncryptEmail) {
				throw new ConvexError("Let's Encrypt requires an email address");
			}
		}
		await upsertWebServerSettings(ctx, {
			host,
			https: args.https,
			certificateType: args.certificateType,
			...(email ? { letsEncryptEmail: email } : {}),
		});
		return await enqueueHostJob(
			ctx,
			{ organizationId, partition: LOCAL_PARTITION, userId },
			traefikGroup(LOCAL_PARTITION),
			{ kind: "infra.webServerApply" },
			{ idempotent: true, maxAttempts: 2 },
		);
	},
});

export const updateServerIp = mutation({
	args: { serverIp: v.string() },
	handler: async (ctx, { serverIp }) => {
		await requireInstanceAdmin(ctx);
		const value = serverIp.trim();
		if (value && !isIp(value)) throw new ConvexError("Invalid IP address");
		await upsertWebServerSettings(ctx, { serverIp: value || undefined });
	},
});

export const updateCacheCleanup = mutation({
	args: {
		cleanupCacheApplications: v.boolean(),
		cleanupCacheOnPreviews: v.boolean(),
		cleanupCacheOnCompose: v.boolean(),
	},
	handler: async (ctx, args) => {
		await requireInstanceAdmin(ctx);
		await upsertWebServerSettings(ctx, args);
	},
});

const MAX_BUILDS_CONCURRENCY = 100;

// Build slots of the panel host (the web server's buildsConcurrency).
export const getLocalBuildsConcurrency = query({
	args: {},
	handler: async (ctx) => {
		await requireInstanceAdmin(ctx);
		const settings = await ctx.db
			.query("instanceSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		return settings?.localBuildsConcurrency ?? 1;
	},
});

export const setLocalBuildsConcurrency = mutation({
	args: { buildsConcurrency: v.number() },
	handler: async (ctx, { buildsConcurrency }) => {
		await requireInstanceAdmin(ctx);
		if (
			!Number.isInteger(buildsConcurrency) ||
			buildsConcurrency < 1 ||
			buildsConcurrency > MAX_BUILDS_CONCURRENCY
		) {
			throw new ConvexError(
				`Builds concurrency must be between 1 and ${MAX_BUILDS_CONCURRENCY}`,
			);
		}
		const settings = await ctx.db
			.query("instanceSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		if (settings) {
			await ctx.db.patch("instanceSettings", settings._id, {
				localBuildsConcurrency: buildsConcurrency,
			});
		} else {
			await ctx.db.insert("instanceSettings", {
				key: "instance",
				localBuildsConcurrency: buildsConcurrency,
			});
		}
	},
});

export const loadTraefikSettings = (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
) =>
	ctx.db
		.query("traefikSettings")
		.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
		.unique();

const upsertTraefikSettings = async (
	ctx: MutationCtx,
	scope: HostScope,
	fields: Partial<
		Pick<
			Doc<"traefikSettings">,
			"additionalPorts" | "dashboardEnabled" | "envManaged"
		>
	>,
): Promise<Id<"traefikSettings">> => {
	const current = await loadTraefikSettings(ctx, scope.serverId);
	if (current) {
		await ctx.db.patch("traefikSettings", current._id, fields);
		return current._id;
	}
	return await ctx.db.insert("traefikSettings", {
		organizationId: scope.organizationId,
		serverId: scope.serverId,
		additionalPorts: [],
		dashboardEnabled: false,
		envManaged: false,
		...fields,
	});
};

const enqueueTraefikApply = (ctx: MutationCtx, scope: HostScope) =>
	enqueueHostJob(
		ctx,
		scope,
		traefikGroup(scope.partition),
		{ kind: "infra.traefikApply", serverId: scope.serverId },
		{ idempotent: true },
	);

export const getTraefikSettings = query({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		await requireHostAccess(ctx, serverId, "admin");
		const settings = await loadTraefikSettings(ctx, serverId);
		return {
			additionalPorts: settings?.additionalPorts ?? [],
			dashboardEnabled: settings?.dashboardEnabled ?? false,
			envManaged: settings?.envManaged ?? false,
		};
	},
});

export const setDashboard = mutation({
	args: { serverId: v.optional(v.id("servers")), enabled: v.boolean() },
	handler: async (ctx, { serverId, enabled }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		await upsertTraefikSettings(ctx, scope, { dashboardEnabled: enabled });
		return await enqueueTraefikApply(ctx, scope);
	},
});

export const setAdditionalPorts = mutation({
	args: {
		serverId: v.optional(v.id("servers")),
		additionalPorts: v.array(traefikPort),
	},
	handler: async (ctx, { serverId, additionalPorts }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		if (additionalPorts.length > 50) throw new ConvexError("Too many ports");
		const seen = new Set<string>();
		for (const port of additionalPorts) {
			validatePort(port.targetPort, "Target port");
			validatePort(port.publishedPort, "Published port");
			if (RESERVED_TRAEFIK_PORTS.has(port.publishedPort)) {
				throw new ConvexError(
					`Port ${port.publishedPort} is managed by Panara Cloud`,
				);
			}
			const key = `${port.publishedPort}/${port.protocol}`;
			if (seen.has(key)) throw new ConvexError(`Duplicate port ${key}`);
			seen.add(key);
		}
		await upsertTraefikSettings(ctx, scope, { additionalPorts });
		return await enqueueTraefikApply(ctx, scope);
	},
});

// Recreates Traefik with the recommended version and the desired settings.
export const applyTraefik = mutation({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		return await enqueueTraefikApply(ctx, scope);
	},
});

// Env vars usually carry DNS-challenge credentials, so they are encrypted
// and only decrypted for the agent applying them. `null` hands control back
// to whatever env the running container has.
export const setTraefikEnv = action({
	args: {
		serverId: v.optional(v.id("servers")),
		env: v.union(v.string(), v.null()),
	},
	handler: async (ctx, { serverId, env }): Promise<Id<"jobs">> => {
		if (env !== null && env.length > MAX_ENV_LENGTH) {
			throw new ConvexError("Environment is too large");
		}
		const encrypted = env === null ? null : await encryptSecret(env);
		return await ctx.runMutation(internal.infra.webServer.storeTraefikEnv, {
			serverId,
			encrypted,
		});
	},
});

export const storeTraefikEnv = internalMutation({
	args: {
		serverId: v.optional(v.id("servers")),
		encrypted: v.union(
			v.object({ iv: v.string(), ciphertext: v.string() }),
			v.null(),
		),
	},
	handler: async (ctx, { serverId, encrypted }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		const settingsId = await upsertTraefikSettings(ctx, scope, {
			envManaged: encrypted !== null,
		});
		const secret = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", TRAEFIK_ENV_SECRET).eq("ownerId", settingsId),
			)
			.unique();
		if (encrypted === null) {
			if (secret) await ctx.db.delete("secrets", secret._id);
		} else if (secret) {
			await ctx.db.patch("secrets", secret._id, encrypted);
		} else {
			await ctx.db.insert("secrets", {
				organizationId: scope.organizationId,
				kind: TRAEFIK_ENV_SECRET,
				ownerId: settingsId,
				...encrypted,
			});
		}
		return await enqueueTraefikApply(ctx, scope);
	},
});

export const reloadTraefik = mutation({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		return await enqueueHostJob(ctx, scope, traefikGroup(scope.partition), {
			kind: "infra.dockerAction",
			serverId,
			action: { type: "traefikRestart" },
		});
	},
});

// Paths are relative to /etc/panara-cloud/traefik (e.g. "traefik.yml",
// "dynamic/middlewares.yml"); the agent rejects anything escaping it.
const validateTraefikPath = (path: string) => {
	if (
		!path ||
		path.length > 512 ||
		path.startsWith("/") ||
		path.split("/").some((part) => part === ".." || part === "") ||
		!/^[A-Za-z0-9._/-]+$/.test(path)
	) {
		throw new ConvexError("Invalid Traefik file path");
	}
	if (path.endsWith("acme.json")) {
		throw new ConvexError("acme.json holds private keys and is not editable");
	}
	// Custom certificates' keys live in dynamic/certificates/ (managed on the
	// Certificates page, which never returns them); key files anywhere stay
	// out of the file browser.
	const lower = path.toLowerCase();
	if (lower.startsWith("dynamic/certificates/") || /\.(key|pem)$/.test(lower)) {
		throw new ConvexError(
			"Certificate and key files are managed on the Certificates page",
		);
	}
	return path;
};

// The Traefik file browser needs traefikFiles.read/write (members get
// read with the canAccessToTraefikFiles grant). The panel host's files stay
// with instance administrators.
const requireTraefikFiles = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
	action: "read" | "write",
) => {
	const scope = await requireHostAccess(ctx, serverId, "member");
	await requirePermission(ctx, scope.organizationId, "traefikFiles", action);
	return scope;
};

export const listTraefikFiles = mutation({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const scope = await requireTraefikFiles(ctx, serverId, "read");
		return await enqueueOp(
			ctx,
			scope,
			`traefik-files:${scope.partition}`,
			{ kind: "infra.traefikFiles", serverId, op: "list" },
			{ restricted: true, idempotent: true },
		);
	},
});

export const readTraefikFile = mutation({
	args: { serverId: v.optional(v.id("servers")), path: v.string() },
	handler: async (ctx, { serverId, path }) => {
		const scope = await requireTraefikFiles(ctx, serverId, "read");
		return await enqueueOp(
			ctx,
			scope,
			`traefik-files:${scope.partition}`,
			{
				kind: "infra.traefikFiles",
				serverId,
				op: "read",
				path: validateTraefikPath(path),
			},
			{ restricted: true, idempotent: true },
		);
	},
});

export const writeTraefikFile = mutation({
	args: {
		serverId: v.optional(v.id("servers")),
		path: v.string(),
		content: v.string(),
	},
	handler: async (ctx, { serverId, path, content }) => {
		const scope = await requireTraefikFiles(ctx, serverId, "write");
		if (content.length > MAX_TRAEFIK_FILE) {
			throw new ConvexError("File is too large");
		}
		return await enqueueOp(
			ctx,
			scope,
			traefikGroup(scope.partition),
			{
				kind: "infra.traefikFiles",
				serverId,
				op: "write",
				path: validateTraefikPath(path),
			},
			{ restricted: true, input: content, idempotent: true },
		);
	},
});
