import { ConvexError, type Infer, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { serviceIdByAppName } from "../lib/appNames";
import {
	requirePermission,
	requireServicePermission,
} from "../lib/permissions";
import { loadService } from "../live/lib";
import { cleanupScope, dockerAction } from "../tables/infra";
import { liveServiceKind } from "../tables/live";
import {
	getRootOrganizationId,
	partitionOf,
	requireHostAccess,
} from "./access";
import { enqueueHostJob, enqueueOp, traefikGroup } from "./hostJobs";
import { DEFAULT_WEB_SERVER_SETTINGS } from "./webServer";

type DockerAction = Infer<typeof dockerAction>;

const RESULT_ACTIONS = new Set<DockerAction["type"]>([
	"containerInspect",
	"imageInspect",
	"volumeInspect",
	"networkInspect",
	"nodeInspect",
	"clusterJoinInfo",
	"containerList",
	"serverHealth",
]);

// What the docker.read permission covers (containers, images, volumes,
// networks, node details); swarm membership and Traefik stay with admins.
const DOCKER_READ_ACTIONS = new Set<DockerAction["type"]>([
	"containerStart",
	"containerStop",
	"containerRestart",
	"containerKill",
	"containerRemove",
	"containerInspect",
	"containerList",
	"imageRemove",
	"imageInspect",
	"volumeRemove",
	"volumeInspect",
	"networkRemove",
	"networkInspect",
	"nodeInspect",
]);

const DOCKER_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/;

const validateAction = (action: DockerAction) => {
	const ref =
		"containerId" in action
			? action.containerId
			: "imageRef" in action
				? action.imageRef
				: "name" in action
					? action.name
					: "nodeId" in action
						? action.nodeId
						: null;
	if (action.type === "containerList" && !DOCKER_REF.test(action.appName)) {
		throw new ConvexError("Invalid app name");
	}
	if (
		action.type === "serverHealth" &&
		(!Number.isInteger(action.sinceHours) ||
			action.sinceHours < 1 ||
			action.sinceHours > 168)
	) {
		throw new ConvexError("The window must be between 1 and 168 hours");
	}
	if (ref !== null && !DOCKER_REF.test(ref)) {
		throw new ConvexError("Invalid Docker object reference");
	}
};

// Containers, images, volumes, networks and swarm nodes. Mutating actions
// refresh the matching snapshot when they finish; inspect-style actions put
// their result in `infraOps` (read it with snapshots.opResult).
export const run = mutation({
	args: { serverId: v.optional(v.id("servers")), action: dockerAction },
	handler: async (ctx, { serverId, action }) => {
		if (action.type === "networkCreate") {
			throw new ConvexError("Create networks through infra.networks.create");
		}
		validateAction(action);
		const dockerRead = DOCKER_READ_ACTIONS.has(action.type);
		const scope = await requireHostAccess(
			ctx,
			serverId,
			dockerRead ? "member" : "admin",
		);
		if (dockerRead) {
			await requirePermission(ctx, scope.organizationId, "docker", "read");
		}
		const spec = { kind: "infra.dockerAction" as const, serverId, action };
		if (action.type === "traefikRestart") {
			return await enqueueHostJob(
				ctx,
				scope,
				traefikGroup(scope.partition),
				spec,
			);
		}
		const group = `docker:${scope.partition}`;
		if (RESULT_ACTIONS.has(action.type)) {
			return await enqueueOp(ctx, scope, group, spec, {
				restricted: action.type === "clusterJoinInfo",
				idempotent: true,
			});
		}
		return await enqueueHostJob(ctx, scope, group, spec);
	},
});

// Containers of a service the caller can read (only needs service.read).
// The
// result arrives in `infraOps`; read it with snapshots.opResult.
export const listServiceContainers = mutation({
	args: { serviceKind: liveServiceKind, serviceId: v.string() },
	handler: async (ctx, { serviceKind, serviceId }) => {
		const service = await loadService(ctx, serviceKind, serviceId);
		const { userId } = await requireServicePermission(
			ctx,
			{ _id: serviceId, organizationId: service.organizationId },
			"service",
			"read",
		);
		const composeType =
			serviceKind === "compose"
				? (service as { composeType?: "docker-compose" | "stack" }).composeType
				: undefined;
		const partition = partitionOf(service.serverId);
		return await enqueueOp(
			ctx,
			{ organizationId: service.organizationId, partition, userId },
			`docker:${partition}`,
			{
				kind: "infra.dockerAction",
				serverId: service.serverId,
				action: {
					type: "containerList",
					appName: service.appName,
					appType: composeType,
				},
			},
			{ restricted: false, idempotent: true },
		);
	},
});

const MAX_RESERVATION_ROWS = 2000;

// Server health needs docker.read and server.read on the host.
const requireHealthAccess = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
) => {
	const scope = await requireHostAccess(ctx, serverId, "member");
	await requirePermission(ctx, scope.organizationId, "docker", "read");
	await requirePermission(ctx, scope.organizationId, "server", "read");
	return scope;
};

// Queues a health check of the host; read the result with
// snapshots.opResult.
export const health = mutation({
	args: { serverId: v.optional(v.id("servers")), sinceHours: v.number() },
	handler: async (ctx, { serverId, sinceHours }) => {
		const action = { type: "serverHealth" as const, sinceHours };
		validateAction(action);
		const scope = await requireHealthAccess(ctx, serverId);
		return await enqueueOp(
			ctx,
			scope,
			`docker:${scope.partition}`,
			{ kind: "infra.dockerAction", serverId, action },
			{ restricted: true, idempotent: true },
		);
	},
});

// Container pickers of the logs and terminal dialogs: containers by app name
// match (service.read) and by app label
// ("swarm"/"standalone", docker.read). On the panel host everyone except its
// instance administrators only gets containers labelled with their
// organization. Read the result with snapshots.opResult.
export const listAppContainers = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		appName: v.string(),
		appType: v.optional(
			v.union(
				v.literal("stack"),
				v.literal("docker-compose"),
				v.literal("swarm"),
				v.literal("standalone"),
			),
		),
	},
	handler: async (ctx, { organizationId, serverId, appName, appType }) => {
		const dockerView = appType === "swarm" || appType === "standalone";
		const access = dockerView
			? await requirePermission(ctx, organizationId, "docker", "read")
			: await requirePermission(ctx, organizationId, "service", "read");
		const { userId, role } = access;
		if (!DOCKER_REF.test(appName)) throw new ConvexError("Invalid app name");
		if (serverId) {
			const server = await ctx.db.get("servers", serverId);
			if (!server || server.organizationId !== organizationId) {
				throw new ConvexError("Server not found");
			}
		}
		const instanceAdmin =
			(role === "owner" || role === "admin") &&
			(await getRootOrganizationId(ctx)) === organizationId;
		// appName is matched against container names on the host, so members
		// (outside the docker view they were granted) name a service they have.
		if (access.scope && !dockerView) {
			const serviceId = await serviceIdByAppName(ctx, organizationId, appName);
			if (!serviceId) throw new ConvexError("Service not found");
			await requireServicePermission(
				ctx,
				{ _id: serviceId, organizationId },
				"service",
				"read",
			);
		}
		const partition = partitionOf(serverId);
		return await enqueueOp(
			ctx,
			{ organizationId, partition, userId },
			`docker:${partition}`,
			{
				kind: "infra.dockerAction",
				serverId,
				action: {
					type: "containerList",
					appName,
					appType,
					organizationId:
						serverId || instanceAdmin ? undefined : organizationId,
				},
			},
			{ restricted: false, idempotent: true },
		);
	},
});

// Memory/CPU reservations of the organization's applications on the host
// (reservation summary); compose services have no such fields.
export const reservation = query({
	args: { serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { serverId }) => {
		const { organizationId } = await requireHealthAccess(ctx, serverId);
		const apps = (
			await ctx.db
				.query("applications")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.take(MAX_RESERVATION_ROWS)
		).filter((app) => app.organizationId === organizationId);
		const composeCount = (
			await ctx.db
				.query("compose")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.take(MAX_RESERVATION_ROWS)
		).filter((row) => row.organizationId === organizationId).length;
		const toInt = (value: string | undefined) => {
			const n = Number.parseInt(value ?? "", 10);
			return Number.isFinite(n) ? n : 0;
		};
		return {
			memoryReservedBytes: apps.reduce(
				(sum, app) => sum + toInt(app.memoryReservation),
				0,
			),
			cpuReservedNanoCpus: apps.reduce(
				(sum, app) => sum + toInt(app.cpuReservation),
				0,
			),
			appCount: apps.length,
			unsupportedComposeCount: composeCount,
		};
	},
});

// Manual cleanups. "all" skips volumes, which are only ever
// pruned on explicit request.
export const cleanup = mutation({
	args: { serverId: v.optional(v.id("servers")), scope: cleanupScope },
	handler: async (ctx, { serverId, scope: cleanupKind }) => {
		if (cleanupKind === "monitoring" && serverId) {
			throw new ConvexError("Monitoring data is only kept on the panel host");
		}
		const scope = await requireHostAccess(ctx, serverId, "admin");
		return await enqueueHostJob(
			ctx,
			scope,
			`cleanup:${scope.partition}`,
			{ kind: "infra.dockerCleanup", serverId, scope: cleanupKind },
			{ idempotent: true },
		);
	},
});

export const setDockerCleanup = mutation({
	args: { serverId: v.optional(v.id("servers")), enabled: v.boolean() },
	handler: async (ctx, { serverId, enabled }) => {
		await requireHostAccess(ctx, serverId, "admin");
		if (serverId) {
			await ctx.db.patch("servers", serverId, { enableDockerCleanup: enabled });
			return;
		}
		const settings = await ctx.db
			.query("webServerSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		if (settings) {
			await ctx.db.patch("webServerSettings", settings._id, {
				enableDockerCleanup: enabled,
			});
		} else {
			await ctx.db.insert("webServerSettings", {
				...DEFAULT_WEB_SERVER_SETTINGS,
				enableDockerCleanup: enabled,
			});
		}
	},
});
