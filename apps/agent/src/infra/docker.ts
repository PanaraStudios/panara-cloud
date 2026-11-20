import type Dockerode from "dockerode";
import type { Host } from "../host/types";
import { paths, TRAEFIK_CONTAINER } from "../lib/constants";
import { quote } from "../lib/shell";
import { runScript } from "./shell";

// Snapshot lists are capped so a busy host can't exceed document limits.
export const MAX_LIST = 1000;

const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

export const listContainers = async (host: Host) => {
	const containers = await host.docker().listContainers({ all: true });
	return containers.slice(0, MAX_LIST).map((c) => ({
		containerId: shortId(c.Id),
		name: c.Names[0]?.replace(/^\//, "") ?? shortId(c.Id),
		image: c.Image,
		ports: (c.Ports ?? [])
			.map((p) =>
				p.PublicPort
					? `${p.IP ?? ""}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`
					: `${p.PrivatePort}/${p.Type}`,
			)
			.join(", "),
		state: c.State,
		status: c.Status,
		created: c.Created,
		service: c.Labels?.["com.docker.swarm.service.name"] ?? null,
		composeProject: c.Labels?.["com.docker.compose.project"] ?? null,
	}));
};

export type ContainerListType =
	| "stack"
	| "docker-compose"
	| "swarm"
	| "standalone"
	| undefined;

// Docker list filters for an app's containers: the compose project or stack
// namespace label, otherwise the swarm service label. Exact label matches: a
// name filter would also match other services' containers. "standalone"
// matches by container name (the panel's own containers). `organizationId` keeps only that organization's containers.
export const containerListFilters = (
	appName: string,
	appType: ContainerListType,
	organizationId?: string,
): Record<string, string[]> => {
	const filters: Record<string, string[]> =
		appType === "stack"
			? { label: [`com.docker.stack.namespace=${appName}`] }
			: appType === "docker-compose"
				? { label: [`com.docker.compose.project=${appName}`] }
				: appType === "standalone"
					? { name: [appName] }
					: { label: [`com.docker.swarm.service.name=${appName}`] };
	if (organizationId) {
		filters.label = [
			...(filters.label ?? []),
			`panara-cloud.organization=${organizationId}`,
		];
	}
	return filters;
};

export const listContainersByApp = async (
	host: Host,
	appName: string,
	appType: ContainerListType,
	organizationId?: string,
) => {
	const containers = await host.docker().listContainers({
		all: true,
		filters: containerListFilters(appName, appType, organizationId),
	});
	return containers.slice(0, MAX_LIST).map((c) => ({
		containerId: shortId(c.Id),
		name: c.Names[0]?.replace(/^\//, "") ?? shortId(c.Id),
		state: c.State,
		status: c.Status,
	}));
};

export const listImages = async (host: Host) => {
	const images = await host.docker().listImages({ all: false });
	return images.slice(0, MAX_LIST).map((image) => ({
		id: shortId(image.Id),
		repoTags: image.RepoTags ?? [],
		size: image.Size,
		created: image.Created,
		containers: image.Containers,
	}));
};

type DfResult = {
	LayersSize?: number;
	Images?: { Containers: number; Size: number; SharedSize: number }[];
	Containers?: { State: string; SizeRw?: number }[];
	Volumes?: { Name: string; UsageData?: { Size: number; RefCount: number } }[];
	BuildCache?: {
		ID: string;
		Type: string;
		Description?: string;
		Size: number;
		CreatedAt: string;
		LastUsedAt?: string | null;
		UsageCount: number;
		Shared: boolean;
		InUse: boolean;
	}[];
};

export const listVolumes = async (host: Host) => {
	const docker = host.docker();
	const [{ Volumes }, df] = await Promise.all([
		docker.listVolumes(),
		(docker.df() as Promise<DfResult>).catch(() => ({}) as DfResult),
	]);
	const usage = new Map((df.Volumes ?? []).map((v) => [v.Name, v.UsageData]));
	return (Volumes ?? []).slice(0, MAX_LIST).map((volume) => ({
		name: volume.Name,
		driver: volume.Driver,
		mountpoint: volume.Mountpoint,
		scope: volume.Scope,
		createdAt: (volume as { CreatedAt?: string }).CreatedAt ?? null,
		size: usage.get(volume.Name)?.Size ?? null,
		refCount: usage.get(volume.Name)?.RefCount ?? null,
	}));
};

export const listNetworks = async (host: Host) => {
	const networks = await host.docker().listNetworks();
	return networks.slice(0, MAX_LIST).map((network) => ({
		id: shortId(network.Id),
		name: network.Name,
		driver: network.Driver,
		scope: network.Scope,
		internal: network.Internal,
		attachable: network.Attachable,
		subnets: (network.IPAM?.Config ?? [])
			.map((config) => config.Subnet)
			.filter((subnet): subnet is string => Boolean(subnet)),
	}));
};

// Disk usage rows from `docker system df`.
export const getDiskUsage = async (host: Host) => {
	const output = await runScript(
		host,
		`$DOCKER system df --format '{{json .}}'`,
	);
	return output
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => {
			const data = JSON.parse(line) as Record<string, string>;
			return {
				type: data.Type ?? "",
				totalCount: Number.parseInt(data.TotalCount ?? "0", 10) || 0,
				active: Number.parseInt(data.Active ?? "0", 10) || 0,
				size: data.Size ?? "",
				reclaimable: data.Reclaimable ?? "",
			};
		});
};

export const getBuildCache = async (host: Host) => {
	const df = (await host.docker().df()) as DfResult;
	return (df.BuildCache ?? []).slice(0, MAX_LIST).map((entry) => ({
		id: entry.ID,
		type: entry.Type,
		description: entry.Description ?? "",
		sizeBytes: entry.Size,
		createdAt: entry.CreatedAt,
		lastUsedAt: entry.LastUsedAt ?? null,
		usageCount: entry.UsageCount,
		shared: entry.Shared,
		inUse: entry.InUse,
	}));
};

type TlsInfo = {
	TrustRoot?: string;
	CertIssuerSubject?: string;
	CertIssuerPublicKey?: string;
};

const isEmptyTls = (tls: TlsInfo | undefined) =>
	!tls?.TrustRoot && !tls?.CertIssuerSubject && !tls?.CertIssuerPublicKey;

// `docker node ls`'s TLS STATUS column: "Needs Rotation" when the node's
// certificate doesn't match the cluster's current root of trust.
export const nodeTlsStatus = (
	node: TlsInfo | undefined,
	cluster: TlsInfo | undefined,
): "Ready" | "Needs Rotation" | "Unknown" => {
	if (isEmptyTls(node) || isEmptyTls(cluster)) return "Unknown";
	return node?.TrustRoot === cluster?.TrustRoot &&
		node?.CertIssuerSubject === cluster?.CertIssuerSubject &&
		node?.CertIssuerPublicKey === cluster?.CertIssuerPublicKey
		? "Ready"
		: "Needs Rotation";
};

export const listSwarmNodes = async (host: Host) => {
	const info = await host.docker().info();
	if (
		info.Swarm?.LocalNodeState !== "active" ||
		!info.Swarm?.ControlAvailable
	) {
		return { swarm: info.Swarm?.LocalNodeState ?? "inactive", nodes: [] };
	}
	const clusterTls = (info.Swarm as { Cluster?: { TLSInfo?: TlsInfo } }).Cluster
		?.TLSInfo;
	const nodes = (await host.docker().listNodes()) as {
		ID: string;
		CreatedAt?: string;
		Spec: {
			Role: string;
			Availability: string;
			Labels?: Record<string, string>;
		};
		Description?: {
			Hostname?: string;
			Platform?: { Architecture?: string; OS?: string };
			Resources?: { NanoCPUs?: number; MemoryBytes?: number };
			Engine?: { EngineVersion?: string };
			TLSInfo?: TlsInfo;
		};
		Status: { State: string; Addr?: string };
		ManagerStatus?: { Leader?: boolean; Reachability?: string; Addr?: string };
	}[];
	return {
		swarm: "active",
		nodes: nodes.slice(0, MAX_LIST).map((node) => ({
			id: node.ID,
			hostname: node.Description?.Hostname ?? "",
			role: node.Spec.Role,
			availability: node.Spec.Availability,
			status: node.Status.State,
			addr: node.Status.Addr ?? null,
			managerStatus: node.ManagerStatus
				? node.ManagerStatus.Leader
					? "Leader"
					: (node.ManagerStatus.Reachability ?? "")
				: "",
			engineVersion: node.Description?.Engine?.EngineVersion ?? "",
			architecture: node.Description?.Platform?.Architecture ?? "",
			nanoCpus: node.Description?.Resources?.NanoCPUs ?? 0,
			memoryBytes: node.Description?.Resources?.MemoryBytes ?? 0,
			createdAt: node.CreatedAt ?? null,
			tlsStatus: nodeTlsStatus(node.Description?.TLSInfo, clusterTls),
		})),
	};
};

const MAX_TASKS = 2000;
const PANEL_SERVICE_PREFIX = "panara-cloud-";

const SERVICE_FIELDS = ["ID", "Name", "Mode", "Replicas", "Image", "Ports"];
const TASK_FIELDS = [
	"ID",
	"Name",
	"Image",
	"Node",
	"DesiredState",
	"CurrentState",
	"Error",
	"Ports",
];

const pick = (row: Record<string, unknown>, fields: string[]) =>
	Object.fromEntries(fields.map((field) => [field, String(row[field] ?? "")]));

export const parseJsonLines = (output: string): Record<string, unknown>[] =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});

// `docker service ls` rows without the panel's own (panara-cloud-*) services.
export const parseSwarmServices = (output: string) =>
	parseJsonLines(output)
		.filter((row) => !String(row.Name ?? "").startsWith(PANEL_SERVICE_PREFIX))
		.slice(0, MAX_LIST)
		.map((row) => pick(row, SERVICE_FIELDS));

export const parseSwarmTasks = (output: string) =>
	parseJsonLines(output)
		.slice(0, MAX_TASKS)
		.map((row) => pick(row, TASK_FIELDS));

// Swarm services and their tasks in one read: `docker service ls` and
// `docker service ps` of those services.
export const listSwarmServices = async (host: Host) => {
	const info = await host.docker().info();
	if (
		info.Swarm?.LocalNodeState !== "active" ||
		!info.Swarm?.ControlAvailable
	) {
		return {
			swarm: info.Swarm?.LocalNodeState ?? "inactive",
			services: [],
			tasks: [],
		};
	}
	const services = parseSwarmServices(
		await runScript(host, `$DOCKER service ls --format '{{json .}}'`),
	);
	const tasks =
		services.length === 0
			? []
			: parseSwarmTasks(
					await runScript(
						host,
						`$DOCKER service ps ${services.map((s) => quote(s.ID ?? "")).join(" ")} --format '{{json .}}' --no-trunc`,
					),
				);
	return { swarm: "active", services, tasks };
};

// The join commands for new worker and manager nodes.
export const getClusterJoinInfo = async (host: Host) => {
	const docker = host.docker();
	const info = await docker.info();
	if (
		info.Swarm?.LocalNodeState !== "active" ||
		!info.Swarm?.ControlAvailable
	) {
		throw new Error("This host is not a Swarm manager");
	}
	const swarm = (await docker.swarmInspect()) as {
		JoinTokens: { Worker: string; Manager: string };
	};
	const address = `${info.Swarm.NodeAddr}:2377`;
	return {
		address,
		version: info.ServerVersion,
		worker: `docker swarm join --token ${swarm.JoinTokens.Worker} ${address}`,
		manager: `docker swarm join --token ${swarm.JoinTokens.Manager} ${address}`,
	};
};

export const removeSwarmNode = async (host: Host, nodeId: string) => {
	const node = host.docker().getNode(nodeId);
	const current = (await node.inspect()) as {
		Version: { Index: number };
		Spec: Record<string, unknown>;
	};
	await node.update({
		version: current.Version.Index,
		...current.Spec,
		Availability: "drain",
	});
	await node.remove({ force: true });
};

export const containerAction = async (
	host: Host,
	containerId: string,
	action: "start" | "stop" | "restart" | "kill" | "remove",
) => {
	const container = host.docker().getContainer(containerId);
	const info = await container.inspect();
	if (
		info.Name.replace(/^\//, "").startsWith(TRAEFIK_CONTAINER) &&
		action === "remove"
	) {
		throw new Error(
			"Traefik is managed by Panara Cloud and can't be removed here",
		);
	}
	switch (action) {
		case "start":
			await container.start();
			return;
		case "stop":
			await container.stop();
			return;
		case "restart":
			await container.restart();
			return;
		case "kill":
			await container.kill({});
			return;
		case "remove":
			await container.remove({ force: true });
			return;
	}
};

// Always sends the IPAM driver ("default" when unset) and only the
// address ranges that were filled in.
export const ipamSpec = (ipam: {
	driver?: string;
	config: { subnet?: string; gateway?: string; ipRange?: string }[];
}) => ({
	Driver: ipam.driver || "default",
	...(ipam.config.length > 0 && {
		Config: ipam.config.map((c) => ({
			Subnet: c.subnet,
			Gateway: c.gateway,
			IPRange: c.ipRange,
		})),
	}),
});

export const createNetwork = async (
	host: Host,
	network: {
		name: string;
		driver: "bridge" | "overlay";
		internal: boolean;
		attachable: boolean;
		enableIPv4: boolean;
		enableIPv6: boolean;
		mtu?: number;
		ipam?: {
			driver?: string;
			config: { subnet?: string; gateway?: string; ipRange?: string }[];
		};
	},
): Promise<string> => {
	const docker = host.docker();
	const existing = await docker
		.getNetwork(network.name)
		.inspect()
		.catch(() => null);
	if (existing) return existing.Id;
	const created = await docker.createNetwork({
		Name: network.name,
		Driver: network.driver,
		Internal: network.internal,
		Attachable: network.attachable,
		EnableIPv6: network.enableIPv6,
		// Missing from dockerode's types; supported by the daemon (API >= 1.47).
		...({ EnableIPv4: network.enableIPv4 } as object),
		Labels: { "panara-cloud.managed": "true" },
		...(network.mtu && {
			Options: { "com.docker.network.driver.mtu": String(network.mtu) },
		}),
		...(network.ipam && {
			IPAM: ipamSpec(network.ipam),
		}),
	} as Dockerode.NetworkCreateOptions);
	return created.id;
};

// Holds cleanups while Docker is busy (builds, pulls), for up to 5 minutes:
// pruning during a build or pull can delete layers it still needs.
export const dockerSafeExec = (exec: string) => `
CHECK_INTERVAL=10
MAX_WAIT=300
WAITED=0
echo "Preparing for execution..."
while true; do
	PROCESSES=$(ps -eo args | awk '$1 ~ /(^|\\/)docker$/')
	# Swarm pulls don't show up in ps (moby/moby#53321)
	PULLING=$($DOCKER node ps self --filter desired-state=running --filter desired-state=ready --format '{{.CurrentState}}' 2>/dev/null | grep '^Preparing')
	if [ -z "$PROCESSES" ] && [ -z "$PULLING" ]; then
		echo "Docker is idle. Starting execution..."
		break
	fi
	if [ "$WAITED" -ge "$MAX_WAIT" ]; then
		echo "Docker still busy after \${MAX_WAIT}s, proceeding anyway." >&2
		break
	fi
	echo "Docker is busy. Will check again in $CHECK_INTERVAL seconds..."
	sleep $CHECK_INTERVAL
	WAITED=$((WAITED + CHECK_INTERVAL))
done
${exec}
echo "Execution completed."
`;

// A stopped Traefik must stay startable; keeping its container also keeps
// its image from `image prune --all`.
const skipIfTraefikStopped = (command: string) => `
if $DOCKER container inspect --format '{{.State.Running}}' ${TRAEFIK_CONTAINER} ${TRAEFIK_CONTAINER}-previous ${TRAEFIK_CONTAINER}-next 2>/dev/null | grep -q false; then
	echo "Skipping '${command}': ${TRAEFIK_CONTAINER} is stopped"
else
	${command}
fi
`;

export const CLEANUP_COMMANDS = {
	containers: skipIfTraefikStopped("$DOCKER container prune --force"),
	images: "$DOCKER image prune --all --force",
	volumes: "$DOCKER volume prune --all --force",
	builders: "$DOCKER builder prune --all --force",
	system: skipIfTraefikStopped("$DOCKER system prune --all --force"),
} as const;

// Patch repo and monitoring cleanups (the monitoring directory is recreated):
// plain file removals that don't wait for Docker to be idle.
export const FILE_CLEANUPS = {
	patches: `$SUDO rm -rf ${quote(paths.patchRepos)}/* 2>/dev/null || true`,
	monitoring: `$SUDO rm -rf ${quote(paths.monitoring)} && $SUDO mkdir -p ${quote(paths.monitoring)}`,
} as const;

export type CleanupScope =
	| keyof typeof CLEANUP_COMMANDS
	| keyof typeof FILE_CLEANUPS
	| "all";

// "all" never prunes volumes: a volume of a stopped container would be lost.
export const cleanupCommandsFor = (scope: CleanupScope): string[] => {
	if (scope === "all") {
		return (["containers", "images", "builders", "system"] as const).map(
			(key) => dockerSafeExec(CLEANUP_COMMANDS[key]),
		);
	}
	if (scope === "patches" || scope === "monitoring") {
		return [FILE_CLEANUPS[scope]];
	}
	if (scope === "system") {
		return [CLEANUP_COMMANDS.system, CLEANUP_COMMANDS.builders].map(
			dockerSafeExec,
		);
	}
	return [dockerSafeExec(CLEANUP_COMMANDS[scope])];
};

export const runCleanup = async (
	host: Host,
	scope: CleanupScope,
	onOutput: (text: string) => void,
	signal?: AbortSignal,
): Promise<{ failed: number }> => {
	let failed = 0;
	for (const command of cleanupCommandsFor(scope)) {
		try {
			await runScript(host, command, { onOutput, signal });
		} catch (error) {
			failed++;
			onOutput(
				`Cleanup step failed: ${error instanceof Error ? error.message : error}\n`,
			);
		}
	}
	return { failed };
};
