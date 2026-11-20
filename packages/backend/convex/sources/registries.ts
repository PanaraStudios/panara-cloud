import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { requireMember } from "../lib/access";
import { encryptSecret } from "../lib/crypto";
import { isTrustedRequester } from "../lib/hostPolicy";
import { enqueueJob } from "../lib/jobs";
import { requirePermission } from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";
import {
	deleteSecret,
	encryptedValue,
	REGISTRY_PASSWORD_KIND,
	REGISTRY_TEST_PASSWORD_KIND,
	writeSecret,
} from "./secrets";

const MAX_REGISTRIES = 200;
const MAX_TESTS_PER_REGISTRY = 20;

// hostname[:port] only: the value ends up in `docker login` and image refs.
const REGISTRY_URL = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(:\d{1,5})?$/;

const registryType = v.union(v.literal("cloud"), v.literal("selfHosted"));

const validateUrl = (registryUrl: string) => {
	const trimmed = registryUrl.trim();
	if (trimmed !== "" && !REGISTRY_URL.test(trimmed)) {
		throw new ConvexError(
			"Registry URL must be a hostname or hostname:port (e.g. registry.example.com or localhost:5000)",
		);
	}
	return trimmed;
};

// Usernames keep their case: AWS ECR requires exactly "AWS".
const validateUsername = (username: string) => {
	const trimmed = username.trim();
	if (!trimmed) throw new ConvexError("Username is required");
	return trimmed;
};

const validateImagePrefix = (prefix: string | undefined) => {
	const trimmed = prefix?.trim();
	if (!trimmed) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(trimmed)) {
		throw new ConvexError("Invalid image prefix");
	}
	return trimmed;
};

const assertServer = async (
	ctx: MutationCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	if (!serverId) {
		// Without a server the test logs the panel host's Docker in, which
		// every service on the panel host shares.
		if (!(await isTrustedRequester(ctx, organizationId))) {
			throw new ConvexError("Select a server to test the registry on");
		}
		return;
	}
	const server = await ctx.db.get("servers", serverId);
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
};

const loadRegistry = async (
	ctx: MutationCtx,
	registryId: Id<"registries">,
	action: "read" | "create",
): Promise<{ registry: Doc<"registries">; userId: string }> => {
	const registry = await ctx.db.get("registries", registryId);
	if (!registry) throw new ConvexError("Registry not found");
	const { userId } = await requirePermission(
		ctx,
		registry.organizationId,
		"registry",
		action,
	);
	return { registry, userId };
};

const startTest = async (
	ctx: MutationCtx,
	test: {
		organizationId: string;
		userId: string;
		registryId?: Id<"registries">;
		registryUrl: string;
		username: string;
		serverId?: Id<"servers">;
		draftPassword?: { iv: string; ciphertext: string };
	},
) => {
	await assertServer(ctx, test.organizationId, test.serverId);
	const testId = await ctx.db.insert("registryTests", {
		organizationId: test.organizationId,
		registryId: test.registryId,
		registryUrl: test.registryUrl,
		username: test.username,
		serverId: test.serverId,
		status: "pending",
	});
	if (test.draftPassword) {
		await writeSecret(ctx, {
			organizationId: test.organizationId,
			kind: REGISTRY_TEST_PASSWORD_KIND,
			ownerId: testId,
			value: test.draftPassword,
		});
	}
	const jobId = await enqueueJob(ctx, {
		organizationId: test.organizationId,
		partition: test.serverId ?? LOCAL_PARTITION,
		group: `registry:${test.registryId ?? testId}`,
		spec: { kind: "sources.registryTest", testId },
		idempotent: true,
		maxAttempts: 2,
		requestedBy: test.userId,
	});
	await ctx.db.patch("registryTests", testId, { jobId });
	if (test.registryId) {
		const registryId = test.registryId;
		const old = await ctx.db
			.query("registryTests")
			.withIndex("by_registryId", (q) => q.eq("registryId", registryId))
			.order("desc")
			.take(MAX_TESTS_PER_REGISTRY + 10);
		for (const row of old.slice(MAX_TESTS_PER_REGISTRY)) {
			await ctx.db.delete("registryTests", row._id);
		}
	}
	return { testId, jobId };
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "registry", "read");
		return await ctx.db
			.query("registries")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_REGISTRIES);
	},
});

// Names only, for members picking a registry for a service.
export const listNames = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		const registries = await ctx.db
			.query("registries")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_REGISTRIES);
		return registries.map((r) => ({
			_id: r._id,
			registryName: r.registryName,
			registryUrl: r.registryUrl,
			imagePrefix: r.imagePrefix,
		}));
	},
});

export const get = query({
	args: { registryId: v.id("registries") },
	handler: async (ctx, { registryId }) => {
		const registry = await ctx.db.get("registries", registryId);
		if (!registry) return null;
		await requirePermission(ctx, registry.organizationId, "registry", "read");
		return registry;
	},
});

export const getTest = query({
	args: { testId: v.id("registryTests") },
	handler: async (ctx, { testId }) => {
		const test = await ctx.db.get("registryTests", testId);
		if (!test) return null;
		await requirePermission(ctx, test.organizationId, "registry", "read");
		return test;
	},
});

const registryFields = {
	registryName: v.string(),
	username: v.string(),
	registryUrl: v.string(),
	registryType: v.optional(registryType),
	imagePrefix: v.optional(v.string()),
};

// Saves the registry and runs `docker login` on `serverId` (or the panel
// host), which both checks and persists the credentials there.
export const create = action({
	args: {
		organizationId: v.string(),
		...registryFields,
		password: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (
		ctx,
		{ password, ...args },
	): Promise<{
		registryId: Id<"registries">;
		testId: Id<"registryTests">;
		jobId: Id<"jobs">;
	}> => {
		if (!password) throw new ConvexError("Password is required");
		return await ctx.runMutation(internal.sources.registries.insert, {
			...args,
			password: await encryptSecret(password),
		});
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		...registryFields,
		password: encryptedValue,
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { password, serverId, ...args }) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"registry",
			"create",
		);
		const registryName = args.registryName.trim();
		if (!registryName) throw new ConvexError("Registry name is required");
		const registryUrl = validateUrl(args.registryUrl);
		const username = validateUsername(args.username);
		const registryId = await ctx.db.insert("registries", {
			organizationId: args.organizationId,
			registryName,
			username,
			registryUrl,
			registryType: args.registryType ?? "cloud",
			imagePrefix: validateImagePrefix(args.imagePrefix),
		});
		await writeSecret(ctx, {
			organizationId: args.organizationId,
			kind: REGISTRY_PASSWORD_KIND,
			ownerId: registryId,
			value: password,
		});
		const test = await startTest(ctx, {
			organizationId: args.organizationId,
			userId,
			registryId,
			registryUrl,
			username,
			serverId,
		});
		return { registryId, ...test };
	},
});

export const update = action({
	args: {
		registryId: v.id("registries"),
		registryName: v.optional(v.string()),
		username: v.optional(v.string()),
		registryUrl: v.optional(v.string()),
		imagePrefix: v.optional(v.string()),
		// Leave empty to keep the stored password.
		password: v.optional(v.string()),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (
		ctx,
		{ password, ...args },
	): Promise<{ testId: Id<"registryTests">; jobId: Id<"jobs"> }> =>
		await ctx.runMutation(internal.sources.registries.applyUpdate, {
			...args,
			password: password ? await encryptSecret(password) : undefined,
		}),
});

export const applyUpdate = internalMutation({
	args: {
		registryId: v.id("registries"),
		registryName: v.optional(v.string()),
		username: v.optional(v.string()),
		registryUrl: v.optional(v.string()),
		imagePrefix: v.optional(v.string()),
		password: v.optional(encryptedValue),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { registryId, password, serverId, ...args }) => {
		const { registry, userId } = await loadRegistry(ctx, registryId, "create");
		if (
			args.registryUrl !== undefined &&
			validateUrl(args.registryUrl) !== registry.registryUrl &&
			!password
		) {
			throw new ConvexError(
				"Enter the password again when changing the registry URL",
			);
		}
		const registryName = args.registryName?.trim();
		if (args.registryName !== undefined && !registryName) {
			throw new ConvexError("Registry name is required");
		}
		const patch = {
			...(registryName ? { registryName } : {}),
			...(args.username !== undefined
				? { username: validateUsername(args.username) }
				: {}),
			...(args.registryUrl !== undefined
				? { registryUrl: validateUrl(args.registryUrl) }
				: {}),
			...(args.imagePrefix !== undefined
				? { imagePrefix: validateImagePrefix(args.imagePrefix) }
				: {}),
		};
		await ctx.db.patch("registries", registryId, patch);
		if (password) {
			await writeSecret(ctx, {
				organizationId: registry.organizationId,
				kind: REGISTRY_PASSWORD_KIND,
				ownerId: registryId,
				value: password,
			});
		}
		const updated = { ...registry, ...patch };
		return await startTest(ctx, {
			organizationId: registry.organizationId,
			userId,
			registryId,
			registryUrl: updated.registryUrl,
			username: updated.username,
			serverId,
		});
	},
});

// Deletes the registry and logs the panel host out of it.
export const remove = mutation({
	args: { registryId: v.id("registries") },
	handler: async (ctx, { registryId }) => {
		const registry = await ctx.db.get("registries", registryId);
		if (!registry) return;
		const { userId } = await requirePermission(
			ctx,
			registry.organizationId,
			"registry",
			"delete",
		);
		await deleteSecret(ctx, REGISTRY_PASSWORD_KIND, registryId);
		const tests = await ctx.db
			.query("registryTests")
			.withIndex("by_registryId", (q) => q.eq("registryId", registryId))
			.take(MAX_TESTS_PER_REGISTRY + 10);
		for (const test of tests) await ctx.db.delete("registryTests", test._id);
		await ctx.db.delete("registries", registryId);
		// Only the instance administrator's registries are logged in on the
		// panel host.
		if (!(await isTrustedRequester(ctx, registry.organizationId))) return;
		await enqueueJob(ctx, {
			organizationId: registry.organizationId,
			partition: LOCAL_PARTITION,
			group: `registry:${registryId}`,
			spec: {
				kind: "sources.registryLogout",
				registryUrl: registry.registryUrl,
			},
			idempotent: true,
			maxAttempts: 2,
			requestedBy: userId,
		});
	},
});

// Checks credentials typed into the form before they are saved.
export const test = action({
	args: {
		organizationId: v.string(),
		registryUrl: v.string(),
		username: v.string(),
		password: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (
		ctx,
		{ password, ...args },
	): Promise<{ testId: Id<"registryTests">; jobId: Id<"jobs"> }> => {
		if (!password) throw new ConvexError("Password is required");
		return await ctx.runMutation(internal.sources.registries.insertDraftTest, {
			...args,
			password: await encryptSecret(password),
		});
	},
});

export const insertDraftTest = internalMutation({
	args: {
		organizationId: v.string(),
		registryUrl: v.string(),
		username: v.string(),
		password: encryptedValue,
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, args) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"registry",
			"read",
		);
		return await startTest(ctx, {
			organizationId: args.organizationId,
			userId,
			registryUrl: validateUrl(args.registryUrl),
			username: validateUsername(args.username),
			serverId: args.serverId,
			draftPassword: args.password,
		});
	},
});

export const testById = mutation({
	args: {
		registryId: v.id("registries"),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { registryId, serverId }) => {
		const { registry, userId } = await loadRegistry(ctx, registryId, "read");
		return await startTest(ctx, {
			organizationId: registry.organizationId,
			userId,
			registryId,
			registryUrl: registry.registryUrl,
			username: registry.username,
			serverId,
		});
	},
});

const TEST_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;

// Test results are only interesting right after the test. Draft passwords
// are normally deleted when the agent reports; this also catches tests whose
// job never ran.
export const cleanupTests = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - TEST_TTL_MS;
		const old = await ctx.db
			.query("registryTests")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(CLEANUP_BATCH);
		for (const test of old) {
			await deleteSecret(ctx, REGISTRY_TEST_PASSWORD_KIND, test._id);
			await ctx.db.delete("registryTests", test._id);
		}
	},
});
