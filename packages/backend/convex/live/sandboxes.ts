import { ConvexError, type Infer, v } from "convex/values";
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
import { assertPanelHostAllowed } from "../infra/access";
import { type requireMember, requireUserId } from "../lib/access";
import { encryptSecret } from "../lib/crypto";
import { enqueueJob } from "../lib/jobs";
import { requirePermission } from "../lib/permissions";
import { deleteSecret, putSecret } from "../lib/secrets";
import { sandboxNetworkMode, sandboxTemplateName } from "../tables/live";
import { atLeast, partitionOf, SANDBOX_ENV_KIND } from "./lib";

type TemplateName = Infer<typeof sandboxTemplateName>;

export const SANDBOX_DEFAULTS = {
	cpu: 1,
	memoryMb: 512,
	pidsLimit: 256,
	timeoutMs: 300_000,
	maxLifetimeMs: 24 * 60 * 60 * 1000,
	workdir: "/home/user",
	user: "1000:1000",
} as const;

// The web server's "remote servers only" setting keeps sandboxes
// off the panel host. Read loosely: the field belongs to infra's settings.
const remoteServersOnly = async (ctx: QueryCtx) => {
	const settings = await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();
	return (
		(settings as { remoteServersOnly?: boolean } | null)?.remoteServersOnly ===
		true
	);
};

const STUCK_CREATING_MS = 10 * 60 * 1000;
const MAX_ACTIVE_PER_ORG = 50;
const LIST_LIMIT = 100;
const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}$/;
const RUNTIME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

type Template = { image: string; description: string; env?: string[] };

// Sandbox templates; all run as 1000:1000 in /home/user.
export const SANDBOX_TEMPLATES: Record<TemplateName, Template> = {
	base: {
		image: "ubuntu:24.04",
		description: "Ubuntu 24.04 with a POSIX shell and coreutils",
	},
	alpine: {
		image: "alpine:3.20",
		description: "Alpine 3.20, the smallest image (busybox)",
	},
	python: {
		image: "python:3.13-slim",
		description: "Python 3.13 (pip available)",
	},
	node: {
		image: "node:22-slim",
		description: "Node.js 22 (npm available)",
	},
	bun: {
		image: "oven/bun:1",
		description: "Bun 1.x runtime and package manager",
	},
	deno: {
		image: "denoland/deno:debian",
		description: "Deno 2.x",
		env: ["DENO_DIR=/home/user/.cache/deno"],
	},
	go: { image: "golang:1.24", description: "Go 1.24" },
	rust: {
		image: "rust:1-slim",
		description: "Rust stable (cargo available)",
		env: [
			"CARGO_HOME=/home/user/.cargo",
			"PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		],
	},
	ruby: {
		image: "ruby:3.3-slim",
		description: "Ruby 3.3 (gem and bundler available)",
		env: [
			"GEM_HOME=/home/user/.gem",
			"BUNDLE_APP_CONFIG=/home/user/.bundle",
			"PATH=/home/user/.gem/bin:/usr/local/bundle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		],
	},
	java: {
		image: "eclipse-temurin:21-jdk",
		description: "Java 21 JDK (Eclipse Temurin)",
	},
	php: { image: "php:8.3-cli", description: "PHP 8.3 CLI" },
};

// The available sandbox templates.
export const templates = query({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx);
		return Object.entries(SANDBOX_TEMPLATES).map(([name, template]) => ({
			name: name as TemplateName,
			image: template.image,
			description: template.description,
		}));
	},
});

const createArgs = {
	organizationId: v.string(),
	serverId: v.optional(v.id("servers")),
	name: v.optional(v.string()),
	template: v.optional(sandboxTemplateName),
	image: v.optional(v.string()),
	cpu: v.optional(v.number()),
	memoryMb: v.optional(v.number()),
	pidsLimit: v.optional(v.number()),
	timeoutMs: v.optional(v.number()),
	maxLifetimeMs: v.optional(v.number()),
	networkMode: v.optional(sandboxNetworkMode),
	workdir: v.optional(v.string()),
	runtime: v.optional(v.string()),
};

const inRange = (
	value: number | undefined,
	min: number,
	max: number,
	label: string,
	integer = true,
) => {
	if (value === undefined) return;
	if ((integer && !Number.isInteger(value)) || value < min || value > max) {
		throw new ConvexError(`${label} must be between ${min} and ${max}`);
	}
};

const isAbsolutePath = (value: string) =>
	value.startsWith("/") &&
	value.length <= 4096 &&
	!value.includes("\0") &&
	!value.split("/").includes("..");

const sandboxGroup = (sandboxId: string) => `sandbox:${sandboxId}`;

const endsAt = (sandbox: Doc<"sandboxes">) =>
	Math.min(sandbox.expiresAt ?? sandbox.deadlineAt, sandbox.deadlineAt);

const scheduleExpiryCheck = async (
	ctx: MutationCtx,
	sandbox: Doc<"sandboxes">,
	at: number,
) => {
	if (sandbox.expiryCheckId) {
		const pending = await ctx.db.system.get(
			"_scheduled_functions",
			sandbox.expiryCheckId,
		);
		if (pending?.state.kind === "pending") {
			await ctx.scheduler.cancel(sandbox.expiryCheckId);
		}
	}
	const expiryCheckId = await ctx.scheduler.runAt(
		at,
		internal.live.sandboxes.checkExpiry,
		{ sandboxId: sandbox._id },
	);
	await ctx.db.patch("sandboxes", sandbox._id, { expiryCheckId });
};

const enqueueKill = (ctx: MutationCtx, sandbox: Doc<"sandboxes">) =>
	enqueueJob(ctx, {
		organizationId: sandbox.organizationId,
		partition: partitionOf(sandbox.serverId),
		group: sandboxGroup(sandbox._id),
		spec: {
			kind: "live.sandboxKill",
			serverId: sandbox.serverId,
			sandboxId: sandbox._id,
		},
		idempotent: true,
		maxAttempts: 3,
	});

export const markKilled = async (
	ctx: MutationCtx,
	sandbox: Doc<"sandboxes">,
	options: { at?: number; removeContainer: boolean },
) => {
	if (sandbox.status !== "killed") {
		await ctx.db.patch("sandboxes", sandbox._id, {
			status: "killed",
			killedAt: options.at ?? Date.now(),
		});
	}
	if (options.removeContainer) await enqueueKill(ctx, sandbox);
};

export const insert = internalMutation({
	args: {
		...createArgs,
		env: v.optional(v.object({ iv: v.string(), ciphertext: v.string() })),
	},
	handler: async (ctx, { env, ...args }) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"sandbox",
			"create",
		);
		if (!args.serverId && (await remoteServersOnly(ctx))) {
			throw new ConvexError("You need to use a server to create a sandbox");
		}
		await assertPanelHostAllowed(ctx, args.organizationId, args.serverId);
		if (args.serverId) {
			const server = await ctx.db.get("servers", args.serverId);
			if (!server || server.organizationId !== args.organizationId) {
				throw new ConvexError("Server not found");
			}
		}
		const recent = await ctx.db
			.query("sandboxes")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", args.organizationId),
			)
			.order("desc")
			.take(MAX_ACTIVE_PER_ORG * 4);
		const active = recent.filter(
			(s) => s.status === "creating" || s.status === "running",
		);
		if (active.length >= MAX_ACTIVE_PER_ORG) {
			throw new ConvexError(
				`At most ${MAX_ACTIVE_PER_ORG} sandboxes can run at once`,
			);
		}
		const now = Date.now();
		const template = args.template ? SANDBOX_TEMPLATES[args.template] : null;
		const image = args.image ?? template?.image;
		if (!image) throw new ConvexError("Either template or image is required");
		const sandboxId = await ctx.db.insert("sandboxes", {
			organizationId: args.organizationId,
			createdBy: userId,
			serverId: args.serverId,
			name: args.name ?? `sandbox-${now.toString(36)}`,
			image,
			template: args.template,
			status: "creating",
			cpu: args.cpu ?? SANDBOX_DEFAULTS.cpu,
			memoryMb: args.memoryMb ?? SANDBOX_DEFAULTS.memoryMb,
			pidsLimit: args.pidsLimit ?? SANDBOX_DEFAULTS.pidsLimit,
			timeoutMs: args.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs,
			deadlineAt: now + (args.maxLifetimeMs ?? SANDBOX_DEFAULTS.maxLifetimeMs),
			networkMode: args.networkMode ?? "isolated",
			workdir: args.workdir ?? SANDBOX_DEFAULTS.workdir,
			user: SANDBOX_DEFAULTS.user,
			runtime: args.runtime,
			hasEnv: env !== undefined,
		});
		if (env) {
			await putSecret(ctx, {
				organizationId: args.organizationId,
				kind: SANDBOX_ENV_KIND,
				ownerId: sandboxId,
				...env,
			});
		}
		const jobId = await enqueueJob(ctx, {
			organizationId: args.organizationId,
			partition: partitionOf(args.serverId),
			group: sandboxGroup(sandboxId),
			spec: { kind: "live.sandboxCreate", sandboxId },
			idempotent: false,
			requestedBy: userId,
		});
		const sandbox = await ctx.db.get("sandboxes", sandboxId);
		if (sandbox)
			await scheduleExpiryCheck(ctx, sandbox, now + STUCK_CREATING_MS);
		return { sandboxId, jobId };
	},
});

export const create = action({
	args: { ...createArgs, envVars: v.optional(v.string()) },
	handler: async (
		ctx,
		{ envVars, ...args },
	): Promise<{ sandboxId: Id<"sandboxes">; jobId: Id<"jobs"> }> => {
		if (!args.template && !args.image) {
			throw new ConvexError("Either template or image is required");
		}
		if (args.image !== undefined && !IMAGE_REF.test(args.image)) {
			throw new ConvexError("Invalid image reference");
		}
		if (
			args.name !== undefined &&
			(!args.name.trim() || args.name.length > 64)
		) {
			throw new ConvexError("Name must be 1-64 characters");
		}
		inRange(args.cpu, 0.1, 64, "CPU", false);
		inRange(args.memoryMb, 64, 262_144, "Memory (MB)");
		inRange(args.pidsLimit, 16, 65_536, "PIDs limit");
		inRange(args.timeoutMs, 10_000, 24 * 60 * 60 * 1000, "Timeout (ms)");
		inRange(
			args.maxLifetimeMs,
			60_000,
			SANDBOX_DEFAULTS.maxLifetimeMs,
			"Max lifetime (ms)",
		);
		if (args.workdir !== undefined && !isAbsolutePath(args.workdir)) {
			throw new ConvexError("Workdir must be an absolute path");
		}
		if (args.runtime !== undefined && !RUNTIME.test(args.runtime)) {
			throw new ConvexError("Invalid runtime name");
		}
		if (envVars !== undefined && envVars.length > 65_536) {
			throw new ConvexError("Environment is too large");
		}
		const templateEnv = args.template
			? (SANDBOX_TEMPLATES[args.template].env ?? [])
			: [];
		const env = [...templateEnv, envVars ?? ""]
			.filter((part) => part.trim())
			.join("\n");
		return await ctx.runMutation(internal.live.sandboxes.insert, {
			...args,
			env: env ? await encryptSecret(env) : undefined,
		});
	},
});

const publicSandbox = (sandbox: Doc<"sandboxes">) => {
	const { expiryCheckId: _check, ...rest } = sandbox;
	return rest;
};

const loadForUser = async (
	ctx: Parameters<typeof requireMember>[0],
	sandboxId: Id<"sandboxes">,
	action: "read" | "create" | "delete",
) => {
	const sandbox = await ctx.db.get("sandboxes", sandboxId);
	if (!sandbox) throw new ConvexError("Sandbox not found");
	const { userId, role } = await requirePermission(
		ctx,
		sandbox.organizationId,
		"sandbox",
		action,
	);
	return { sandbox, userId, role };
};

export const list = query({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.union(v.id("servers"), v.null())),
	},
	handler: async (ctx, { organizationId, serverId }) => {
		await requirePermission(ctx, organizationId, "sandbox", "read");
		const rows = await ctx.db
			.query("sandboxes")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(LIST_LIMIT);
		return rows
			.filter((row) =>
				serverId === undefined
					? true
					: serverId === null
						? row.serverId === undefined
						: row.serverId === serverId,
			)
			.map(publicSandbox);
	},
});

export const get = query({
	args: { sandboxId: v.id("sandboxes") },
	handler: async (ctx, { sandboxId }) => {
		const sandbox = await ctx.db.get("sandboxes", sandboxId);
		if (!sandbox) return null;
		await requirePermission(ctx, sandbox.organizationId, "sandbox", "read");
		return publicSandbox(sandbox);
	},
});

// Members manage the sandboxes they created; admins manage all of them.
const requireManage = async (
	ctx: MutationCtx,
	sandboxId: Id<"sandboxes">,
	action: "create" | "delete" = "create",
) => {
	const { sandbox, userId, role } = await loadForUser(ctx, sandboxId, action);
	if (sandbox.createdBy !== userId && !atLeast(role, "admin")) {
		throw new ConvexError("Only the creator or an admin can do this");
	}
	return { sandbox, userId };
};

export const kill = mutation({
	args: { sandboxId: v.id("sandboxes") },
	handler: async (ctx, { sandboxId }) => {
		const { sandbox } = await requireManage(ctx, sandboxId);
		await markKilled(ctx, sandbox, { removeContainer: true });
	},
});

export const remove = mutation({
	args: { sandboxId: v.id("sandboxes") },
	handler: async (ctx, { sandboxId }) => {
		const { sandbox } = await requireManage(ctx, sandboxId, "delete");
		if (sandbox.status !== "killed" || sandbox.containerId) {
			await enqueueKill(ctx, sandbox);
		}
		if (sandbox.expiryCheckId) {
			const pending = await ctx.db.system.get(
				"_scheduled_functions",
				sandbox.expiryCheckId,
			);
			if (pending?.state.kind === "pending") {
				await ctx.scheduler.cancel(sandbox.expiryCheckId);
			}
		}
		await deleteSecret(ctx, SANDBOX_ENV_KIND, sandboxId);
		await ctx.db.delete("sandboxes", sandboxId);
	},
});

export const updateTimeout = mutation({
	args: { sandboxId: v.id("sandboxes"), timeoutMs: v.number() },
	handler: async (ctx, { sandboxId, timeoutMs }) => {
		inRange(timeoutMs, 10_000, 24 * 60 * 60 * 1000, "Timeout (ms)");
		const { sandbox, userId } = await requireManage(ctx, sandboxId);
		if (sandbox.status !== "running") {
			throw new ConvexError(`Sandbox is ${sandbox.status}`);
		}
		const now = Date.now();
		await ctx.db.patch("sandboxes", sandboxId, {
			timeoutMs,
			lastActivityAt: now,
			expiresAt: Math.min(now + timeoutMs, sandbox.deadlineAt),
		});
		const updated = await ctx.db.get("sandboxes", sandboxId);
		if (updated) await scheduleExpiryCheck(ctx, updated, endsAt(updated));
		return await enqueueJob(ctx, {
			organizationId: sandbox.organizationId,
			partition: partitionOf(sandbox.serverId),
			group: sandboxGroup(sandboxId),
			spec: { kind: "live.sandboxSetTimeout", sandboxId, timeoutMs },
			idempotent: true,
			requestedBy: userId,
		});
	},
});

// Runs at the sandbox's expiry. Activity moves expiresAt forward, in which
// case the check reschedules itself instead of killing.
export const checkExpiry = internalMutation({
	args: { sandboxId: v.id("sandboxes") },
	handler: async (ctx, { sandboxId }) => {
		const sandbox = await ctx.db.get("sandboxes", sandboxId);
		if (!sandbox) return;
		const now = Date.now();
		// Scheduled ten minutes after creation; starting cancels it.
		if (sandbox.status === "creating") {
			await ctx.db.patch("sandboxes", sandboxId, {
				status: "error",
				error: "Sandbox did not start in time",
			});
			await enqueueKill(ctx, sandbox);
			return;
		}
		if (sandbox.status !== "running") return;
		const end = endsAt(sandbox);
		if (now >= end) {
			await markKilled(ctx, sandbox, { at: end, removeContainer: true });
		} else {
			await scheduleExpiryCheck(ctx, sandbox, end);
		}
	},
});

export const onStarted = async (
	ctx: MutationCtx,
	sandbox: Doc<"sandboxes">,
	containerId: string,
) => {
	const now = Date.now();
	await ctx.db.patch("sandboxes", sandbox._id, {
		status: "running",
		containerId,
		lastActivityAt: now,
		expiresAt: Math.min(now + sandbox.timeoutMs, sandbox.deadlineAt),
		error: undefined,
	});
	const updated = await ctx.db.get("sandboxes", sandbox._id);
	if (updated) await scheduleExpiryCheck(ctx, updated, endsAt(updated));
};

export const touch = async (ctx: MutationCtx, sandbox: Doc<"sandboxes">) => {
	const now = Date.now();
	await ctx.db.patch("sandboxes", sandbox._id, {
		lastActivityAt: now,
		expiresAt: Math.min(now + sandbox.timeoutMs, sandbox.deadlineAt),
	});
};
