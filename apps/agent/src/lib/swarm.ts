import type Dockerode from "dockerode";
import type { AuthConfig, CreateServiceOptions } from "dockerode";
import type { Host } from "../host/types";
import { NETWORK_NAME, PANARA_CLOUD_LABEL, paths } from "./constants";
import { quote } from "./shell";

type KeyValue = { key: string; value: string }[];

export type Mount =
	| { type: "bind"; hostPath: string; mountPath: string }
	| { type: "volume"; volumeName: string; mountPath: string }
	| { type: "file"; filePath: string; content: string; mountPath: string };

// Mirrors the backend's swarmSettings + resourceSettings validators
// (packages/backend/convex/lib/serviceSettings.ts).
export type SwarmSettings = {
	healthCheckSwarm?: {
		Test?: string[];
		Interval?: number;
		Timeout?: number;
		StartPeriod?: number;
		Retries?: number;
	};
	restartPolicySwarm?: {
		Condition?: string;
		Delay?: number;
		MaxAttempts?: number;
		Window?: number;
	};
	placementSwarm?: {
		Constraints?: string[];
		Preferences?: { Spread: { SpreadDescriptor: string } }[];
		MaxReplicas?: number;
		Platforms?: { Architecture: string; OS: string }[];
	};
	updateConfigSwarm?: UpdateConfig;
	rollbackConfigSwarm?: UpdateConfig;
	modeSwarm?: {
		Replicated?: { Replicas?: number };
		Global?: Record<string, never>;
		ReplicatedJob?: { MaxConcurrent?: number; TotalCompletions?: number };
		GlobalJob?: Record<string, never>;
	};
	labelsSwarm?: KeyValue;
	networkSwarm?: {
		Target?: string;
		Aliases?: string[];
		DriverOpts?: KeyValue;
	}[];
	stopGracePeriodSwarm?: number;
	endpointSpecSwarm?: {
		Mode?: string;
		Ports?: {
			Protocol?: string;
			TargetPort?: number;
			PublishedPort?: number;
			PublishMode?: string;
		}[];
	};
	ulimitsSwarm?: { Name: string; Soft: number; Hard: number }[];
};

type UpdateConfig = {
	Parallelism: number;
	Delay?: number;
	FailureAction?: string;
	Monitor?: number;
	MaxFailureRatio?: number;
	Order: string;
};

export type Resources = {
	memoryLimit?: string;
	memoryReservation?: string;
	cpuLimit?: string;
	cpuReservation?: string;
};

const toRecord = (pairs: KeyValue | undefined): Record<string, string> =>
	Object.fromEntries((pairs ?? []).map(({ key, value }) => [key, value]));

const toInt = (value: string | undefined) =>
	value ? Number.parseInt(value, 10) : undefined;

export const calculateResources = (resources: Resources) => ({
	Limits: {
		MemoryBytes: toInt(resources.memoryLimit),
		NanoCPUs: toInt(resources.cpuLimit),
	},
	Reservations: {
		MemoryBytes: toInt(resources.memoryReservation),
		NanoCPUs: toInt(resources.cpuReservation),
	},
});

export const fileMountsDir = (appName: string) =>
	`${paths.applications}/${appName}/files`;

const toDockerMount = (appName: string, mount: Mount) => {
	if (mount.type === "volume") {
		return {
			Type: "volume" as const,
			Source: mount.volumeName,
			Target: mount.mountPath,
		};
	}
	return {
		Type: "bind" as const,
		Source:
			mount.type === "bind"
				? mount.hostPath
				: `${fileMountsDir(appName)}/${mount.filePath}`,
		Target: mount.mountPath,
	};
};

export const generateMounts = (appName: string, mounts: Mount[]) =>
	mounts.map((mount) => toDockerMount(appName, mount));

// Writes file-mount contents under /etc/panara-cloud/applications/<appName>/files.
export const writeFileMounts = async (
	host: Host,
	appName: string,
	mounts: Mount[],
) => {
	const base = fileMountsDir(appName);
	for (const mount of mounts) {
		if (mount.type !== "file") continue;
		if (
			mount.filePath.startsWith("/") ||
			mount.filePath.split("/").includes("..")
		) {
			throw new Error(`Invalid file mount path: ${mount.filePath}`);
		}
		const target = `${base}/${mount.filePath}`;
		// Refuse to write through a symlink planted by a container or repository.
		const check = await host.exec(`test -L ${quote(target)}`);
		if (check.code === 0)
			throw new Error(`Refusing to write through symlink: ${target}`);
		await host.writeFile(target, mount.content);
	}
};

// Swarm service config shared by applications and databases, with the
// defaults used when a setting is left empty.
export const generateServiceConfig = (
	settings: SwarmSettings & { replicas?: number; hasMounts: boolean },
) => ({
	HealthCheck: settings.healthCheckSwarm,
	RestartPolicy: settings.restartPolicySwarm,
	Placement: settings.placementSwarm ?? {
		// Services with mounts stay on the manager, where their data lives.
		Constraints: settings.hasMounts ? ["node.role==manager"] : [],
	},
	Labels: toRecord(settings.labelsSwarm),
	Mode: settings.modeSwarm ?? {
		Replicated: { Replicas: settings.replicas ?? 1 },
	},
	RollbackConfig: settings.rollbackConfigSwarm ?? {
		Parallelism: 1,
		Order: "start-first",
	},
	UpdateConfig: settings.updateConfigSwarm ?? {
		Parallelism: 1,
		Order: "start-first",
		FailureAction: "rollback",
	},
	StopGracePeriod: settings.stopGracePeriodSwarm,
	EndpointSpec: settings.endpointSpecSwarm
		? {
				...(settings.endpointSpecSwarm.Mode && {
					Mode: settings.endpointSpecSwarm.Mode,
				}),
				Ports: (settings.endpointSpecSwarm.Ports ?? []).map((port) => ({
					Protocol: (port.Protocol || "tcp") as "tcp" | "udp" | "sctp",
					TargetPort: port.TargetPort || 0,
					PublishedPort: port.PublishedPort || 0,
					PublishMode: (port.PublishMode || "host") as "ingress" | "host",
				})),
			}
		: undefined,
	Ulimits: settings.ulimitsSwarm?.length ? settings.ulimitsSwarm : undefined,
	Networks: settings.networkSwarm?.length
		? settings.networkSwarm.map((network) => ({
				Target: network.Target,
				Aliases: network.Aliases,
				DriverOpts: toRecord(network.DriverOpts),
			}))
		: [{ Target: NETWORK_NAME }],
});

export type PanaraCloudLabels = {
	organizationId: string;
	projectId: string;
	environmentId: string;
	serviceKind: string;
	serviceId: string;
	serviceName: string;
};

// Labels that let logs, metrics and cleanup tie containers back to Panara Cloud.
export const panaraCloudLabels = (
	labels: PanaraCloudLabels,
): Record<string, string> => ({
	[PANARA_CLOUD_LABEL]: "true",
	"panara-cloud.organization": labels.organizationId,
	"panara-cloud.project": labels.projectId,
	"panara-cloud.environment": labels.environmentId,
	"panara-cloud.service.kind": labels.serviceKind,
	"panara-cloud.service.id": labels.serviceId,
	"panara-cloud.service.name": labels.serviceName,
});

// Creates the service, or updates it in place (forcing a rolling restart so a
// re-pushed tag with the same name is picked up).
// Swarm takes an update only for the version of the service it was read at,
// and moves that version itself while it finishes the update before (its
// status going from "updating" to "completed"). A deploy that comes right
// after another one then fails with "update out of sequence". The service
// is read again and the update repeated: nothing was changed by the refused
// call.
const OUT_OF_SEQUENCE = /update out of sequence/i;
export const inSequence = async <T>(
	readAndUpdate: () => Promise<T>,
	options: { retries?: number; pauseMs?: number } = {},
): Promise<T> => {
	const { retries = 4, pauseMs = 250 } = options;
	for (let attempt = 0; ; attempt++) {
		try {
			return await readAndUpdate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt >= retries || !OUT_OF_SEQUENCE.test(message)) throw error;
			await new Promise((resolve) =>
				setTimeout(resolve, pauseMs * (attempt + 1)),
			);
		}
	}
};

export const upsertService = async (
	docker: Dockerode,
	settings: CreateServiceOptions,
	// Registry credentials for private images. dockerode only forwards them
	// on create when passed as a separate first argument.
	auth?: AuthConfig,
) => {
	const name = settings.Name as string;
	try {
		const service = docker.getService(name);
		await inSequence(async () => {
			const inspect = await service.inspect();
			await service.update({
				...settings,
				...(auth && { authconfig: auth }),
				version: Number.parseInt(inspect.Version.Index, 10),
				TaskTemplate: {
					...settings.TaskTemplate,
					ForceUpdate: (inspect.Spec?.TaskTemplate?.ForceUpdate ?? 0) + 1,
				},
			});
		});
		return "updated" as const;
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
		if (auth) {
			await docker.createService(auth, settings);
		} else {
			await docker.createService(settings);
		}
		return "created" as const;
	}
};

export const removeService = async (docker: Dockerode, name: string) => {
	try {
		await docker.getService(name).remove();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
	}
};

export const scaleService = async (
	docker: Dockerode,
	name: string,
	replicas: number,
) => {
	const service = docker.getService(name);
	const inspect = await service.inspect();
	await service.update({
		...inspect.Spec,
		version: Number.parseInt(inspect.Version.Index, 10),
		Mode: { Replicated: { Replicas: replicas } },
	});
};
