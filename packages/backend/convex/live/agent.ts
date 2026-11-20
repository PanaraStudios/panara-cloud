import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireAgent } from "../lib/agentAuth";
import { sha256Hex } from "../lib/crypto";
import { requireLease } from "../lib/lease";
import { readSecret } from "../lib/secrets";
import { resolveHostTarget } from "../lib/targets";
import {
	loadService,
	MONITORING_TOKEN_KIND,
	partitionOf,
	SANDBOX_ENV_KIND,
} from "./lib";
import { markKilled, onStarted, touch } from "./sandboxes";

const lease = { jobId: v.id("jobs"), leaseId: v.string() };
const MAX_KILLS = 100;
const RESET_BATCH = 200;

type JobSpec = Doc<"jobs">["spec"];

const requireSpec = async <K extends JobSpec["kind"]>(
	ctx: QueryCtx,
	args: { jobId: Id<"jobs">; leaseId: string },
	kinds: readonly K[],
) => {
	const { job } = await requireLease(ctx, args.jobId, args.leaseId);
	if (!(kinds as readonly string[]).includes(job.spec.kind)) {
		throw new ConvexError(`Not available for ${job.spec.kind} jobs`);
	}
	return { job, spec: job.spec as Extract<JobSpec, { kind: K }> };
};

const sessionExtra = async (ctx: QueryCtx, session: Doc<"liveSessions">) => {
	const request = session.request;
	switch (request.kind) {
		case "hostTerminal":
			return {
				type: "hostTerminal" as const,
				local: request.serverId
					? null
					: (request.local ?? { username: "root", port: 22 }),
			};
		case "sandbox": {
			const sandbox = await ctx.db.get("sandboxes", request.sandboxId);
			if (sandbox?.status !== "running" || !sandbox.containerId) {
				throw new ConvexError("Sandbox is not running");
			}
			return {
				type: "sandbox" as const,
				sandboxId: sandbox._id,
				containerId: sandbox.containerId,
				user: sandbox.user,
				workdir: sandbox.workdir,
			};
		}
		case "metrics": {
			const serverId =
				request.scope.type === "host"
					? request.scope.serverId
					: (
							await loadService(
								ctx,
								request.scope.serviceKind,
								request.scope.serviceId,
							)
						).serverId;
			const config = await ctx.db
				.query("monitoringConfigs")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.unique();
			const token = config
				? await readSecret(ctx, MONITORING_TOKEN_KIND, config._id)
				: null;
			if (!config?.enabled || !token) {
				throw new ConvexError("Monitoring is not set up on this server");
			}
			const appName =
				request.scope.type === "service"
					? (request.containerName ??
						(
							await loadService(
								ctx,
								request.scope.serviceKind,
								request.scope.serviceId,
							)
						).appName)
					: null;
			return {
				type: "metrics" as const,
				port: config.settings.port,
				token,
				appName,
			};
		}
		default:
			return { type: "none" as const };
	}
};

// Exchanges a browser's single-use token for what the agent needs to serve
// the stream. Everything comes from the stored session, never the browser.
export const redeem = mutation({
	args: { token: v.string() },
	handler: async (ctx, { token }) => {
		const agent = await requireAgent(ctx);
		if (token.length < 20 || token.length > 128) {
			throw new ConvexError("Invalid token");
		}
		const tokenHash = await sha256Hex(token);
		const session = await ctx.db
			.query("liveSessions")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.unique();
		if (session?.status !== "pending") {
			throw new ConvexError("Invalid or used token");
		}
		const now = Date.now();
		if (session.connectBy < now) {
			await ctx.db.patch("liveSessions", session._id, {
				status: "closed",
				closedAt: now,
				closeReason: "expired",
			});
			return null;
		}
		const extra = await sessionExtra(ctx, session);
		const target = await resolveHostTarget(ctx, session.partition);
		await ctx.db.patch("liveSessions", session._id, {
			status: "open",
			openedAt: now,
			agentId: agent._id,
		});
		return {
			sessionId: session._id,
			organizationId: session.organizationId,
			userId: session.userId,
			request: session.request,
			restriction: session.restriction ?? null,
			target,
			extra,
		};
	},
});

const requireOwnSession = async (
	ctx: MutationCtx,
	sessionId: Id<"liveSessions">,
) => {
	const agent = await requireAgent(ctx);
	const session = await ctx.db.get("liveSessions", sessionId);
	if (!session || session.agentId !== agent._id) {
		throw new ConvexError("Session not found");
	}
	return session;
};

export const closed = mutation({
	args: { sessionId: v.id("liveSessions"), reason: v.string() },
	handler: async (ctx, { sessionId, reason }) => {
		const session = await requireOwnSession(ctx, sessionId);
		if (session.status === "closed") return;
		await ctx.db.patch("liveSessions", sessionId, {
			status: "closed",
			closedAt: Date.now(),
			closeReason: session.killRequested ? "killed" : reason.slice(0, 200),
		});
	},
});

// The agent subscribes to this and closes the listed streams.
export const killRequests = query({
	args: {},
	handler: async (ctx) => {
		const agent = await requireAgent(ctx);
		const sessions = await ctx.db
			.query("liveSessions")
			.withIndex("by_status_and_killRequested", (q) =>
				q.eq("status", "open").eq("killRequested", true),
			)
			.take(MAX_KILLS);
		return sessions
			.filter((session) => session.agentId === agent._id)
			.map((session) => session._id);
	},
});

// On agent start: whatever it had open before died with the process.
export const resetSessions = mutation({
	args: {},
	handler: async (ctx) => {
		const agent = await requireAgent(ctx);
		const open = await ctx.db
			.query("liveSessions")
			.withIndex("by_agentId_and_status", (q) =>
				q.eq("agentId", agent._id).eq("status", "open"),
			)
			.take(RESET_BATCH);
		const now = Date.now();
		for (const session of open) {
			await ctx.db.patch("liveSessions", session._id, {
				status: "closed",
				closedAt: now,
				closeReason: "agent restarted",
			});
		}
		return open.length;
	},
});

const sandboxOfSession = async (
	ctx: MutationCtx,
	sessionId: Id<"liveSessions">,
) => {
	const session = await requireOwnSession(ctx, sessionId);
	if (session.status !== "open" || session.request.kind !== "sandbox") {
		throw new ConvexError("Not an open sandbox session");
	}
	const sandbox = await ctx.db.get("sandboxes", session.request.sandboxId);
	if (!sandbox) throw new ConvexError("Sandbox not found");
	return sandbox;
};

// Called on every exec/file operation; returns false once the sandbox has
// been killed so the agent ends the stream.
export const touchSandbox = mutation({
	args: { sessionId: v.id("liveSessions") },
	handler: async (ctx, { sessionId }) => {
		const sandbox = await sandboxOfSession(ctx, sessionId);
		if (sandbox.status !== "running") return false;
		const end = Math.min(
			sandbox.expiresAt ?? sandbox.deadlineAt,
			sandbox.deadlineAt,
		);
		if (end <= Date.now()) {
			await markKilled(ctx, sandbox, { at: end, removeContainer: true });
			return false;
		}
		await touch(ctx, sandbox);
		return true;
	},
});

export const sandboxGone = mutation({
	args: { sessionId: v.id("liveSessions") },
	handler: async (ctx, { sessionId }) => {
		const sandbox = await sandboxOfSession(ctx, sessionId);
		await markKilled(ctx, sandbox, { removeContainer: true });
	},
});

export const getSandboxContext = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, [
			"live.sandboxCreate",
			"live.sandboxSetTimeout",
		]);
		const sandbox = await ctx.db.get("sandboxes", spec.sandboxId);
		if (!sandbox) throw new ConvexError("Sandbox not found");
		const env = sandbox.hasEnv
			? await readSecret(ctx, SANDBOX_ENV_KIND, sandbox._id)
			: null;
		return {
			sandboxId: sandbox._id,
			organizationId: sandbox.organizationId,
			status: sandbox.status,
			image: sandbox.image,
			cpu: sandbox.cpu,
			memoryMb: sandbox.memoryMb,
			pidsLimit: sandbox.pidsLimit,
			timeoutMs: sandbox.timeoutMs,
			deadlineAt: sandbox.deadlineAt,
			networkMode: sandbox.networkMode,
			workdir: sandbox.workdir,
			user: sandbox.user,
			runtime: sandbox.runtime ?? null,
			containerId: sandbox.containerId ?? null,
			env,
		};
	},
});

// Returns false when the sandbox was killed or removed while starting, so
// the agent removes the container it just created.
export const reportSandboxStarted = mutation({
	args: { ...lease, containerId: v.string() },
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["live.sandboxCreate"]);
		const sandbox = await ctx.db.get("sandboxes", spec.sandboxId);
		if (sandbox?.status !== "creating") return false;
		await onStarted(ctx, sandbox, args.containerId);
		return true;
	},
});

export const reportSandboxFailed = mutation({
	args: { ...lease, error: v.string() },
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["live.sandboxCreate"]);
		const sandbox = await ctx.db.get("sandboxes", spec.sandboxId);
		if (sandbox?.status !== "creating") return;
		await ctx.db.patch("sandboxes", sandbox._id, {
			status: "error",
			error: args.error.slice(0, 2000),
		});
	},
});

const callbackUrl = () =>
	process.env.PANARA_CLOUD_MONITORING_CALLBACK_URL ??
	`${process.env.CONVEX_SITE_URL}/live/monitoring/alert`;

// METRICS_CONFIG for the monitoring container, including its token.
export const getMonitoringContext = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["live.monitoringSetup"]);
		const config = await ctx.db
			.query("monitoringConfigs")
			.withIndex("by_serverId", (q) => q.eq("serverId", spec.serverId))
			.unique();
		if (!config) throw new ConvexError("Monitoring is not configured");
		const token = await readSecret(ctx, MONITORING_TOKEN_KIND, config._id);
		if (!token) throw new ConvexError("Monitoring token missing");
		const { settings } = config;
		return {
			isLocal: partitionOf(spec.serverId) === "local",
			port: settings.port,
			metricsConfig: {
				server: {
					type: spec.serverId ? "Remote" : "Panel",
					refreshRate: settings.refreshRate,
					port: settings.port,
					token,
					urlCallback: callbackUrl(),
					retentionDays: settings.retentionDays,
					cronJob: settings.cronJob,
					thresholds: settings.thresholds,
				},
				containers: {
					refreshRate: settings.containers.refreshRate,
					services: {
						include: settings.containers.include,
						exclude: settings.containers.exclude,
					},
				},
			},
		};
	},
});
