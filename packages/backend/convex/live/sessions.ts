import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireMember, requireUserId } from "../lib/access";
import { sha256Hex } from "../lib/crypto";
import { requirePermission } from "../lib/permissions";
import { liveRequest } from "../tables/live";
import {
	atLeast,
	belongsToApp,
	type LiveRequest,
	type LiveScope,
	MAX_OPEN_SESSIONS_PER_USER,
	partitionOf,
	type ResolvedScope,
	requireHostAdmin,
	resolveScope,
	SESSION_CONNECT_MS,
	validateRequest,
} from "./lib";

const TOKEN_BYTES = 32;
const LIST_LIMIT = 100;

const toBase64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

type Authorized = Pick<
	ResolvedScope,
	"userId" | "organizationId" | "partition" | "restriction"
>;

// Service sessions need access to the service (and logs/monitoring read for
// those streams); host-wide Docker views need docker.read, which
// members get with the canAccessToDocker grant.
const resolveLiveScope = async (
	ctx: QueryCtx,
	scope: LiveScope,
	stream?: "logs" | "monitoring",
): Promise<ResolvedScope> => {
	const resolved = await resolveScope(ctx, scope);
	if (scope.type === "host") {
		await requirePermission(ctx, resolved.organizationId, "docker", "read");
	} else if (stream) {
		await requirePermission(ctx, resolved.organizationId, stream, "read");
	}
	return resolved;
};

export const authorizeRequest = async (
	ctx: QueryCtx,
	request: LiveRequest,
): Promise<Authorized> => {
	validateRequest(request);
	switch (request.kind) {
		case "hostTerminal":
		case "accessLog":
			return await requireHostAdmin(
				ctx,
				request.organizationId,
				request.serverId,
			);
		case "containerTerminal":
		case "dockerEvents":
		case "files":
			return await resolveLiveScope(ctx, request.scope);
		case "containerLogs":
		case "serviceContainers":
			return await resolveLiveScope(ctx, request.scope, "logs");
		case "containerStats": {
			const scope = await resolveLiveScope(ctx, request.scope, "monitoring");
			if (request.target.type === "host" && scope.restriction) {
				throw new ConvexError("Host stats require an administrator");
			}
			return scope;
		}
		case "metrics": {
			const scope =
				request.scope.type === "host"
					? await requireHostAdmin(
							ctx,
							request.scope.organizationId,
							request.scope.serverId,
							"member",
						)
					: await resolveLiveScope(ctx, request.scope, "monitoring");
			if (
				request.containerName !== undefined &&
				!(scope.appName && belongsToApp(request.containerName, scope.appName))
			) {
				throw new ConvexError("Container does not belong to this service");
			}
			const config = await ctx.db
				.query("monitoringConfigs")
				.withIndex("by_serverId", (q) => q.eq("serverId", scope.serverId))
				.unique();
			if (!config?.enabled) {
				throw new ConvexError("Monitoring is not set up on this server");
			}
			return scope;
		}
		case "sandbox": {
			const sandbox = await ctx.db.get("sandboxes", request.sandboxId);
			if (!sandbox) throw new ConvexError("Sandbox not found");
			const { userId } = await requirePermission(
				ctx,
				sandbox.organizationId,
				"sandbox",
				"create",
			);
			if (sandbox.status !== "running" || !sandbox.containerId) {
				throw new ConvexError(`Sandbox is ${sandbox.status}`);
			}
			return {
				userId,
				organizationId: sandbox.organizationId,
				partition: partitionOf(sandbox.serverId),
				restriction: undefined,
			};
		}
	}
};

export const insert = internalMutation({
	args: { request: liveRequest, tokenHash: v.string() },
	handler: async (ctx, { request, tokenHash }) => {
		const scope = await authorizeRequest(ctx, request);
		const active = [
			...(await ctx.db
				.query("liveSessions")
				.withIndex("by_userId_and_status", (q) =>
					q.eq("userId", scope.userId).eq("status", "open"),
				)
				.take(MAX_OPEN_SESSIONS_PER_USER)),
			...(await ctx.db
				.query("liveSessions")
				.withIndex("by_userId_and_status", (q) =>
					q.eq("userId", scope.userId).eq("status", "pending"),
				)
				.take(MAX_OPEN_SESSIONS_PER_USER)),
		];
		if (active.length >= MAX_OPEN_SESSIONS_PER_USER) {
			throw new ConvexError("Too many open live sessions; close some first");
		}
		const connectBy = Date.now() + SESSION_CONNECT_MS;
		const sessionId = await ctx.db.insert("liveSessions", {
			organizationId: scope.organizationId,
			userId: scope.userId,
			kind: request.kind,
			partition: scope.partition,
			tokenHash,
			status: "pending",
			request,
			restriction: scope.restriction,
			connectBy,
			killRequested: false,
		});
		return { sessionId, connectBy };
	},
});

// Authorizes a live stream and returns a single-use token for the agent's
// WebSocket endpoint: `<agent>/live?token=...`. The token is minted here
// rather than in a mutation so it comes from an unseeded random source.
export const open = action({
	args: { request: liveRequest },
	handler: async (
		ctx,
		{ request },
	): Promise<{
		sessionId: Id<"liveSessions">;
		token: string;
		path: string;
		url: string | null;
		expiresAt: number;
	}> => {
		const token = toBase64Url(
			crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)),
		);
		const { sessionId, connectBy } = await ctx.runMutation(
			internal.live.sessions.insert,
			{ request, tokenHash: await sha256Hex(token) },
		);
		const path = `/live?token=${token}`;
		const base = process.env.PANARA_CLOUD_LIVE_URL?.replace(/\/+$/, "");
		return {
			sessionId,
			token,
			path,
			url: base ? `${base}${path}` : null,
			expiresAt: connectBy,
		};
	},
});

// The owner of a session or an admin of its organization can end it; the
// agent watches killRequested and closes the stream.
export const kill = mutation({
	args: { sessionId: v.id("liveSessions") },
	handler: async (ctx, { sessionId }) => {
		const session = await ctx.db.get("liveSessions", sessionId);
		if (!session) throw new ConvexError("Session not found");
		const { userId, role } = await requireMember(ctx, session.organizationId);
		if (session.userId !== userId && !atLeast(role, "admin")) {
			throw new ConvexError("Not your session");
		}
		if (session.status === "closed") return;
		if (session.status === "pending") {
			await ctx.db.patch("liveSessions", sessionId, {
				status: "closed",
				closedAt: Date.now(),
				closeReason: "killed",
			});
			return;
		}
		await ctx.db.patch("liveSessions", sessionId, { killRequested: true });
	},
});

const publicSession = (session: {
	_id: Id<"liveSessions">;
	_creationTime: number;
	userId: string;
	kind: string;
	partition: string;
	status: "pending" | "open" | "closed";
	openedAt?: number;
	closedAt?: number;
	closeReason?: string;
	killRequested: boolean;
}) => ({
	sessionId: session._id,
	createdAt: session._creationTime,
	userId: session.userId,
	kind: session.kind,
	partition: session.partition,
	status: session.status,
	openedAt: session.openedAt ?? null,
	closedAt: session.closedAt ?? null,
	closeReason: session.closeReason ?? null,
	killRequested: session.killRequested,
});

export const get = query({
	args: { sessionId: v.id("liveSessions") },
	handler: async (ctx, { sessionId }) => {
		const session = await ctx.db.get("liveSessions", sessionId);
		if (!session) return null;
		const { userId, role } = await requireMember(ctx, session.organizationId);
		if (session.userId !== userId && !atLeast(role, "admin")) return null;
		return publicSession(session);
	},
});

// Open sessions of an organization: admins see everyone's, members their own.
export const listOpen = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId, role } = await requireMember(ctx, organizationId);
		const sessions = atLeast(role, "admin")
			? await ctx.db
					.query("liveSessions")
					.withIndex("by_organizationId_and_status", (q) =>
						q.eq("organizationId", organizationId).eq("status", "open"),
					)
					.take(LIST_LIMIT)
			: (
					await ctx.db
						.query("liveSessions")
						.withIndex("by_userId_and_status", (q) =>
							q.eq("userId", userId).eq("status", "open"),
						)
						.take(LIST_LIMIT)
				).filter((s) => s.organizationId === organizationId);
		return sessions.map(publicSession);
	},
});

export const mine = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const sessions = await ctx.db
			.query("liveSessions")
			.withIndex("by_userId_and_status", (q) =>
				q.eq("userId", userId).eq("status", "open"),
			)
			.take(LIST_LIMIT);
		return sessions.map(publicSession);
	},
});
