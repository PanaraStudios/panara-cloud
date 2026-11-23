import { ConvexError, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getRootOrganizationId } from "../infra/access";
import { LIVE_SNAPSHOT_INTERVAL, LIVE_SNAPSHOTS } from "../infra/hostJobs";
import { type Role, requireMember } from "../lib/access";
import { requireServicePermission } from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";
import type {
	liveRequest,
	liveRestriction,
	liveScope,
	liveServiceKind,
} from "../tables/live";

export type LiveRequest = Infer<typeof liveRequest>;
export type LiveScope = Infer<typeof liveScope>;
export type LiveRestriction = Infer<typeof liveRestriction>;
export type LiveServiceKind = Infer<typeof liveServiceKind>;

export const SESSION_CONNECT_MS = 60_000;
export const MAX_OPEN_SESSIONS_PER_USER = 20;
export const MAX_METRICS_POINTS = 10_000;
// The collector refuses more buckets than this in one answer.
export const MAX_METRICS_BUCKETS = 2000;
const MAX_METRICS_WINDOW_SECONDS = 400 * 86_400;
const MAX_METRICS_STEP_SECONDS = 30 * 86_400;
export const SANDBOX_ENV_KIND = "live.sandboxEnv";
export const MONITORING_TOKEN_KIND = "live.monitoringToken";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export const DOCKER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const HEX_ID = /^[a-f0-9]{12,64}$/i;
const SINCE = /^(all|\d{1,6}[smhd])$/;
// The agent passes the search to `grep -F` as a quoted argument; only
// control characters (which would break line-based filtering) are refused.
const isValidSearch = (value: string) =>
	value.length <= 500 &&
	[...value].every((char) => char >= " " && char !== "\u007f");
const USERNAME = /^[a-z_][a-z0-9_.-]{0,31}$/i;

export const isValidContainerRef = (value: string) =>
	HEX_ID.test(value) || DOCKER_REF.test(value);

// Compose containers are named after their project: `<project>-<service>-1`
// (docker compose) or `<stack>_<service>.1.<task>` (swarm stacks).
export const belongsToApp = (containerName: string, appName: string) =>
	containerName === appName ||
	["-", "_", "."].some((sep) => containerName.startsWith(`${appName}${sep}`));

export const partitionOf = (serverId: string | undefined) =>
	serverId ?? LOCAL_PARTITION;

export type ResolvedScope = {
	userId: string;
	role: Role;
	organizationId: string;
	serverId: Id<"servers"> | undefined;
	partition: string;
	restriction: LiveRestriction | undefined;
	// Docker name of the service (swarm service / compose project), when the
	// scope is a service.
	appName?: string;
};

export const loadService = async (
	ctx: QueryCtx,
	kind: LiveServiceKind,
	serviceId: string,
) => {
	const table =
		kind === "application"
			? "applications"
			: kind === "compose"
				? "compose"
				: "databases";
	const id = ctx.db.normalizeId(table, serviceId);
	const row = id ? await ctx.db.get(table, id as never) : null;
	if (!row) throw new ConvexError("Service not found");
	return row as {
		organizationId: string;
		serverId?: Id<"servers">;
		appName: string;
	};
};

// The panel host belongs to the instance's first organization; its admins
// reach every container on it, everyone else only their organization's.
const isInstanceAdmin = async (
	ctx: QueryCtx,
	organizationId: string,
	role: Role,
) =>
	atLeast(role, "admin") &&
	(await getRootOrganizationId(ctx)) === organizationId;

export const resolveScope = async (
	ctx: QueryCtx,
	scope: LiveScope,
	minRole: Role = "member",
): Promise<ResolvedScope> => {
	if (scope.type === "service") {
		const service = await loadService(ctx, scope.serviceKind, scope.serviceId);
		if (minRole !== "member") {
			await requireMember(ctx, service.organizationId, minRole);
		}
		// Access to the service is the gate.
		const { userId, role } = await requireServicePermission(
			ctx,
			{ _id: scope.serviceId, organizationId: service.organizationId },
			"service",
			"read",
		);
		return {
			userId,
			role,
			organizationId: service.organizationId,
			serverId: service.serverId,
			partition: partitionOf(service.serverId),
			restriction: {
				organizationId: service.organizationId,
				serviceId: scope.serviceId,
			},
			appName: service.appName,
		};
	}
	if (scope.serverId) {
		const server = await ctx.db.get("servers", scope.serverId);
		if (!server || server.organizationId !== scope.organizationId) {
			throw new ConvexError("Server not found");
		}
	}
	const { userId, role } = await requireMember(
		ctx,
		scope.organizationId,
		minRole,
	);
	const unrestricted = scope.serverId
		? atLeast(role, "admin")
		: await isInstanceAdmin(ctx, scope.organizationId, role);
	return {
		userId,
		role,
		organizationId: scope.organizationId,
		serverId: scope.serverId,
		partition: partitionOf(scope.serverId),
		restriction: unrestricted
			? undefined
			: { organizationId: scope.organizationId },
	};
};

// Host-level access without containers in between (host terminal, access
// log, panel metrics): admins of the server's organization, or instance
// admins for the panel host.
export const requireHostAdmin = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
	minRole: Role = "admin",
): Promise<ResolvedScope> => {
	const resolved = await resolveScope(
		ctx,
		{ type: "host", organizationId, serverId },
		minRole,
	);
	if (!serverId && resolved.restriction) {
		throw new ConvexError("Requires an instance administrator");
	}
	return resolved;
};

// The same bounds the agent applies to the windows a session asks for later
// (apps/agent/src/live/metricsWindow.ts).
const assertMetricsWindow = (window: {
	from: number;
	to: number;
	step: number;
}) => {
	const { from, to, step } = window;
	if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) {
		throw new ConvexError("The window's from and to must be Unix seconds");
	}
	if (!(from < to) || to - from > MAX_METRICS_WINDOW_SECONDS) {
		throw new ConvexError(
			"The window must run from an earlier to a later time",
		);
	}
	if (!Number.isInteger(step) || step < 1 || step > MAX_METRICS_STEP_SECONDS) {
		throw new ConvexError("The step must be a whole number of seconds");
	}
	if (Math.ceil((to - from) / step) > MAX_METRICS_BUCKETS) {
		throw new ConvexError(
			`A window holds at most ${MAX_METRICS_BUCKETS} buckets: use a longer step`,
		);
	}
};

export const validateRequest = (request: LiveRequest) => {
	switch (request.kind) {
		case "hostTerminal":
			if (request.serverId && request.local) {
				throw new ConvexError("Local login settings apply to the panel host");
			}
			if (request.local) {
				const { username, port } = request.local;
				if (!USERNAME.test(username)) throw new ConvexError("Invalid username");
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					throw new ConvexError("Invalid port");
				}
			}
			return;
		case "containerTerminal":
			if (!isValidContainerRef(request.containerId)) {
				throw new ConvexError("Invalid container ID");
			}
			return;
		case "containerLogs":
			if (!isValidContainerRef(request.containerId)) {
				throw new ConvexError("Invalid container ID");
			}
			if (
				!Number.isInteger(request.tail) ||
				request.tail < 0 ||
				request.tail > 10_000
			) {
				throw new ConvexError("Tail must be between 0 and 10000");
			}
			if (!SINCE.test(request.since)) {
				throw new ConvexError("Invalid since value");
			}
			if (request.search !== undefined && !isValidSearch(request.search)) {
				throw new ConvexError(
					"Search must be at most 500 characters without control characters",
				);
			}
			return;
		case "containerStats":
			if (
				request.target.type === "container" &&
				!isValidContainerRef(request.target.containerId)
			) {
				throw new ConvexError("Invalid container ID");
			}
			if (
				request.target.type === "service" &&
				!DOCKER_REF.test(request.target.serviceName)
			) {
				throw new ConvexError("Invalid service name");
			}
			return;
		case "files":
			if (
				request.target.type === "container" &&
				!isValidContainerRef(request.target.containerId)
			) {
				throw new ConvexError("Invalid container ID");
			}
			if (
				request.target.type === "volume" &&
				!DOCKER_REF.test(request.target.volumeName)
			) {
				throw new ConvexError("Invalid volume name");
			}
			return;
		case "metrics":
			if (
				request.dataPoints !== "all" &&
				(!Number.isInteger(request.dataPoints) ||
					request.dataPoints < 1 ||
					request.dataPoints > MAX_METRICS_POINTS)
			) {
				throw new ConvexError(
					`Data points must be between 1 and ${MAX_METRICS_POINTS}`,
				);
			}
			if (
				request.containerName !== undefined &&
				!DOCKER_REF.test(request.containerName)
			) {
				throw new ConvexError("Invalid container name");
			}
			if (request.window !== undefined) {
				if (
					request.scope.type !== "host" ||
					request.containerName !== undefined
				) {
					throw new ConvexError("A time window applies to host metrics only");
				}
				assertMetricsWindow(request.window);
			}
			return;
		case "dockerEvents":
			if (
				request.sinceMinutes !== undefined &&
				(!Number.isInteger(request.sinceMinutes) ||
					request.sinceMinutes < 1 ||
					request.sinceMinutes > 1440)
			) {
				throw new ConvexError("Since must be between 1 and 1440 minutes");
			}
			return;
		case "serviceContainers":
			if (!DOCKER_REF.test(request.appName)) {
				throw new ConvexError("Invalid app name");
			}
			return;
		case "hostSnapshot":
			if (!LIVE_SNAPSHOTS.has(request.what)) {
				throw new ConvexError(`${request.what} is not kept fresh live`);
			}
			if (
				!Number.isInteger(request.intervalMs) ||
				request.intervalMs < LIVE_SNAPSHOT_INTERVAL.min ||
				request.intervalMs > LIVE_SNAPSHOT_INTERVAL.max
			) {
				throw new ConvexError(
					`The interval must be between ${LIVE_SNAPSHOT_INTERVAL.min / 1000} and ${LIVE_SNAPSHOT_INTERVAL.max / 1000} seconds`,
				);
			}
			return;
		case "sandbox":
		case "accessLog":
			return;
	}
};
