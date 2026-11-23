import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireMember } from "../lib/access";
import { requirePermission } from "../lib/permissions";
import {
	assertPanelHostAllowed,
	partitionOf,
	requireHostAccess,
} from "./access";
import { enqueueHostJob } from "./hostJobs";
import { isIpOrCidr, validateNetworkName } from "./validation";

const MAX_NETWORKS = 200;
const MAX_SERVICE_NETWORKS = 20;
const PANARA_CLOUD_NETWORK = "panara-cloud-network";

type ServiceNetworkSettings = {
	serverId?: Id<"servers">;
	networkIds?: Id<"networks">[];
	detachPanaraCloudNetwork?: boolean;
	networkSwarm?: { Target?: string }[];
};

// Checks networks a swarm service (application or database) joins: overlay
// networks of its organization on its own server. Detaching from
// panara-cloud-network needs another network to stay reachable.
export const validateServiceNetworks = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
	networkIds: Id<"networks">[],
	detachPanaraCloudNetwork: boolean,
): Promise<Id<"networks">[]> => {
	const unique = [...new Set(networkIds)];
	if (unique.length > MAX_SERVICE_NETWORKS) {
		throw new ConvexError("Too many networks");
	}
	for (const networkId of unique) {
		const network = await ctx.db.get("networks", networkId);
		if (
			!network ||
			network.organizationId !== organizationId ||
			network.serverId !== serverId
		) {
			throw new ConvexError("Network not found on the service's server");
		}
		if (network.driver !== "overlay") {
			throw new ConvexError(
				`${network.name} is a bridge network; swarm services can only join overlay networks`,
			);
		}
	}
	if (detachPanaraCloudNetwork && unique.length === 0) {
		throw new ConvexError(
			"Select another network before detaching from panara-cloud-network",
		);
	}
	return unique;
};

// Resolves a service's networks: an explicit networkSwarm wins; otherwise
// panara-cloud-network (unless detached) plus the selected networks that exist on
// the service's server. Undefined keeps the default (panara-cloud-network only).
export const resolveServiceNetworks = async (
	ctx: QueryCtx,
	service: ServiceNetworkSettings,
): Promise<{ Target: string }[] | undefined> => {
	if (service.networkSwarm?.length) return undefined;
	if (!service.networkIds?.length && !service.detachPanaraCloudNetwork) {
		return undefined;
	}
	const names: string[] = [];
	for (const networkId of service.networkIds ?? []) {
		const network = await ctx.db.get("networks", networkId);
		if (
			network &&
			network.driver === "overlay" &&
			network.serverId === service.serverId
		) {
			names.push(network.name);
		}
	}
	const targets = service.detachPanaraCloudNetwork
		? names
		: [PANARA_CLOUD_NETWORK, ...names];
	return targets.length > 0 ? targets.map((Target) => ({ Target })) : undefined;
};

// Docker plugin names: `default`, `null`, or `[registry/]name[:tag]`.
const IPAM_DRIVER = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

const ipamConfig = v.object({
	subnet: v.optional(v.string()),
	gateway: v.optional(v.string()),
	ipRange: v.optional(v.string()),
});

// Custom Docker networks that services can join besides panara-cloud-network.
export const list = query({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { organizationId, serverId }) => {
		await requireMember(ctx, organizationId);
		const rows = await ctx.db
			.query("networks")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_NETWORKS);
		return rows.filter((row) => row.serverId === serverId);
	},
});

export const create = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		name: v.string(),
		driver: v.union(v.literal("bridge"), v.literal("overlay")),
		internal: v.optional(v.boolean()),
		attachable: v.optional(v.boolean()),
		enableIPv4: v.optional(v.boolean()),
		enableIPv6: v.optional(v.boolean()),
		mtu: v.optional(v.number()),
		ipamDriver: v.optional(v.string()),
		ipamConfig: v.optional(v.array(ipamConfig)),
	},
	handler: async (ctx, args) => {
		const { userId } = await requirePermission(
			ctx,
			args.organizationId,
			"docker",
			"read",
		);
		await assertPanelHostAllowed(ctx, args.organizationId, args.serverId);
		if (args.serverId) {
			const server = await ctx.db.get("servers", args.serverId);
			if (!server || server.organizationId !== args.organizationId) {
				throw new ConvexError("Server not found");
			}
		}
		const name = validateNetworkName(args.name.trim());
		const clash = await ctx.db
			.query("networks")
			.withIndex("by_serverId_and_name", (q) =>
				q.eq("serverId", args.serverId).eq("name", name),
			)
			.first();
		if (clash) throw new ConvexError(`Network ${name} already exists`);
		if (
			args.mtu !== undefined &&
			(!Number.isInteger(args.mtu) || args.mtu < 68 || args.mtu > 65535)
		) {
			throw new ConvexError("MTU must be between 68 and 65535");
		}
		const config = args.ipamConfig ?? [];
		for (const entry of config) {
			for (const value of [entry.subnet, entry.gateway, entry.ipRange]) {
				if (value && !isIpOrCidr(value)) {
					throw new ConvexError(`Invalid address: ${value}`);
				}
			}
		}
		const ipamDriver = args.ipamDriver?.trim() || undefined;
		if (ipamDriver !== undefined && !IPAM_DRIVER.test(ipamDriver)) {
			throw new ConvexError("Invalid IPAM driver");
		}
		const enableIPv4 = args.enableIPv4 ?? true;
		const enableIPv6 = args.enableIPv6 ?? false;
		if (!enableIPv4 && !enableIPv6) {
			throw new ConvexError("Enable IPv4, IPv6 or both");
		}
		const networkId = await ctx.db.insert("networks", {
			organizationId: args.organizationId,
			serverId: args.serverId,
			name,
			driver: args.driver,
			internal: args.internal ?? false,
			attachable: args.attachable ?? args.driver === "overlay",
			enableIPv4,
			enableIPv6,
			mtu: args.mtu,
			ipam:
				config.length > 0 || ipamDriver
					? { driver: ipamDriver, config }
					: undefined,
			status: "pending",
		});
		await enqueueHostJob(
			ctx,
			{
				organizationId: args.organizationId,
				partition: partitionOf(args.serverId),
				userId,
			},
			`docker:${partitionOf(args.serverId)}`,
			{
				kind: "infra.dockerAction",
				serverId: args.serverId,
				action: { type: "networkCreate", networkId },
			},
			{ idempotent: true, maxAttempts: 2 },
		);
		return networkId;
	},
});

export const remove = mutation({
	args: { networkId: v.id("networks") },
	handler: async (ctx, { networkId }) => {
		const network = await ctx.db.get("networks", networkId);
		if (!network) return;
		const { userId } = await requirePermission(
			ctx,
			network.organizationId,
			"docker",
			"read",
		);
		await assertPanelHostAllowed(ctx, network.organizationId, network.serverId);
		await ctx.db.delete("networks", networkId);
		if (network.status === "pending" && !network.dockerId) return;
		await enqueueHostJob(
			ctx,
			{
				organizationId: network.organizationId,
				partition: partitionOf(network.serverId),
				userId,
			},
			`docker:${partitionOf(network.serverId)}`,
			{
				kind: "infra.dockerAction",
				serverId: network.serverId,
				action: { type: "networkRemove", name: network.name },
			},
		);
	},
});

const RESERVED_NETWORKS = new Set([
	"bridge",
	"host",
	"none",
	"ingress",
	"docker_gwbridge",
	PANARA_CLOUD_NETWORK,
]);

type DockerNetwork = {
	id: string;
	name: string;
	driver: string;
	internal: boolean;
	attachable: boolean;
	subnets: string[];
};

// Snapshot ids are Docker's 12-character short ids; rows keep whatever the
// agent reported, full or short.
const sameDockerId = (a: string, b: string) =>
	a.startsWith(b) || b.startsWith(a);

const isImportable = (network: DockerNetwork) =>
	!RESERVED_NETWORKS.has(network.name) &&
	(network.driver === "bridge" || network.driver === "overlay");

// Networks rows of an organization on one host, and the host's Docker
// networks from the latest `networks` snapshot (null before the first read).
const loadHostNetworks = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	await requirePermission(ctx, organizationId, "docker", "read");
	const scope = await requireHostAccess(ctx, serverId, "member");
	if (scope.serverId && scope.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
	const rows = (
		await ctx.db
			.query("networks")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_NETWORKS)
	).filter((row) => row.serverId === serverId);
	const snapshot = await ctx.db
		.query("infraSnapshots")
		.withIndex("by_serverId_and_kind", (q) =>
			q.eq("serverId", serverId).eq("kind", "networks"),
		)
		.unique();
	let docker: DockerNetwork[] | null = null;
	if (snapshot?.data) {
		try {
			docker = JSON.parse(snapshot.data) as DockerNetwork[];
		} catch {
			docker = null;
		}
	}
	return { scope, rows, docker, refreshedAt: snapshot?.refreshedAt ?? null };
};

// Networks to sync: Docker networks not tracked yet, tracked
// networks missing from Docker, and tracked networks Docker recreated.
export const toSync = query({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { organizationId, serverId }) => {
		const { rows, docker, refreshedAt } = await loadHostNetworks(
			ctx,
			organizationId,
			serverId,
		);
		if (!docker) {
			return { importable: [], missing: [], changed: [], refreshedAt };
		}
		const names = new Set(rows.map((row) => row.name));
		const byName = new Map(docker.map((network) => [network.name, network]));
		return {
			importable: docker
				.filter((network) => isImportable(network) && !names.has(network.name))
				.map((network) => ({
					name: network.name,
					driver: network.driver,
					internal: network.internal,
					attachable: network.attachable,
					subnets: network.subnets,
				})),
			missing: rows
				.filter((row) => row.status !== "pending" && !byName.has(row.name))
				.map((row) => ({ networkId: row._id, name: row.name })),
			changed: rows.flatMap((row) => {
				const network = byName.get(row.name);
				if (
					!row.dockerId ||
					!network ||
					sameDockerId(row.dockerId, network.id)
				) {
					return [];
				}
				return [
					{
						networkId: row._id,
						name: row.name,
						driver: network.driver,
						internal: network.internal,
						attachable: network.attachable,
					},
				];
			}),
			refreshedAt,
		};
	},
});

const fromDocker = (network: DockerNetwork) => ({
	driver: network.driver as "bridge" | "overlay",
	internal: network.internal,
	attachable: network.attachable,
	dockerId: network.id,
	ipam:
		network.subnets.length > 0
			? { config: network.subnets.map((subnet) => ({ subnet })) }
			: undefined,
	status: "created" as const,
	error: undefined,
});

// Tracks existing Docker networks of the host.
export const importDocker = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		names: v.array(v.string()),
	},
	handler: async (ctx, { organizationId, serverId, names }) => {
		if (names.length > MAX_NETWORKS) throw new ConvexError("Too many networks");
		const { rows, docker } = await loadHostNetworks(
			ctx,
			organizationId,
			serverId,
		);
		if (!docker) throw new ConvexError("Refresh the host's networks first");
		const existing = new Set(rows.map((row) => row.name));
		const byName = new Map(docker.map((network) => [network.name, network]));
		const imported: string[] = [];
		const errors: { name: string; error: string }[] = [];
		for (const name of new Set(names)) {
			const network = byName.get(name);
			if (existing.has(name)) {
				errors.push({ name, error: "Already imported" });
			} else if (!network) {
				errors.push({ name, error: "Network not found" });
			} else if (!isImportable(network)) {
				errors.push({ name, error: "Network is reserved or not supported" });
			} else {
				await ctx.db.insert("networks", {
					organizationId,
					serverId,
					name,
					enableIPv4: true,
					enableIPv6: false,
					...fromDocker(network),
				});
				imported.push(name);
			}
		}
		return { imported, errors };
	},
});

// Takes Docker's current settings for a row.
export const resync = mutation({
	args: { networkId: v.id("networks") },
	handler: async (ctx, { networkId }) => {
		const row = await ctx.db.get("networks", networkId);
		if (!row) throw new ConvexError("Network not found");
		const { docker } = await loadHostNetworks(
			ctx,
			row.organizationId,
			row.serverId,
		);
		const network = docker?.find((entry) => entry.name === row.name);
		if (!network) throw new ConvexError(`${row.name} does not exist in Docker`);
		await ctx.db.patch("networks", networkId, fromDocker(network));
	},
});

// Creates the Docker network again from the row
// (a no-op on the host when it already exists).
export const recreate = mutation({
	args: { networkId: v.id("networks") },
	handler: async (ctx, { networkId }) => {
		const row = await ctx.db.get("networks", networkId);
		if (!row) throw new ConvexError("Network not found");
		const { userId } = await requirePermission(
			ctx,
			row.organizationId,
			"docker",
			"read",
		);
		await ctx.db.patch("networks", networkId, {
			status: "pending",
			error: undefined,
		});
		const partition = partitionOf(row.serverId);
		return await enqueueHostJob(
			ctx,
			{ organizationId: row.organizationId, partition, userId },
			`docker:${partition}`,
			{
				kind: "infra.dockerAction",
				serverId: row.serverId,
				action: { type: "networkCreate", networkId },
			},
			{ idempotent: true, maxAttempts: 2 },
		);
	},
});
