import { randomBytes } from "node:crypto";
import type Dockerode from "dockerode";
import type { ContainerSpec, CreateServiceOptions } from "dockerode";
import { type Host, HostCommandError } from "../host";
import { BASE_PATH } from "../lib/constants";
import { pinnedImage } from "../lib/pinnedImage";
import { quote } from "../lib/shell";

export const VECTOR_IMAGE = "timberio/vector:0.58.0-alpine";
export const VECTOR_SERVICE_NAME = "panara-cloud-vector";
export const VECTOR_PATH = `${BASE_PATH}/vector`;
const VECTOR_CONFIG_CONTAINER_DIR = "/etc/vector";
const VECTOR_CONFIG_CONTAINER_PATH = `${VECTOR_CONFIG_CONTAINER_DIR}/vector.yaml`;
const VECTOR_DATA_DIR_CONTAINER = "/var/lib/vector";

export const CADVISOR_IMAGE = "ghcr.io/google/cadvisor:v0.60.6";
export const CADVISOR_SERVICE_NAME = "panara-cloud-cadvisor";
export const CADVISOR_PORT = 4510;
const METRICS_SCRAPE_INTERVAL_SECS = 30;

const PANARA_CLOUD_LABELS = [
	"panara-cloud.organization.id",
	"panara-cloud.project",
	"panara-cloud.project.id",
	"panara-cloud.environment",
	"panara-cloud.environment.id",
	"panara-cloud.application",
	"panara-cloud.application.id",
	"panara-cloud.service",
];

// Runs a command as root, via sudo when the SSH user isn't root.
const asRoot = (command: string) =>
	`if [ "$(id -u)" -eq 0 ]; then bash -c ${quote(command)}; else sudo bash -c ${quote(command)}; fi`;

export const redactSecrets = (text: string, secrets: string[]): string => {
	let redacted = text;
	for (const secret of secrets) {
		if (secret) redacted = redacted.split(secret).join("[redacted]");
	}
	return redacted;
};

const describeError = (error: unknown) =>
	error instanceof HostCommandError
		? error.output.trim() || error.message
		: error instanceof Error
			? error.message
			: String(error);

type Log = (line: string) => void;

// Writes the config to a candidate file, validates it with the Vector image,
// then swaps it in, so a bad config never replaces a working one.
export const syncVectorConfig = async (
	host: Host,
	configYaml: string,
	secrets: string[],
	options: { basePath?: string; validate?: boolean; signal?: AbortSignal } = {},
) => {
	const basePath = options.basePath ?? VECTOR_PATH;
	const configPath = `${basePath}/vector.yaml`;
	const candidatePath = `${basePath}/vector.yaml.candidate.${randomBytes(5).toString("hex")}`;
	const redact = (error: unknown) =>
		redactSecrets(describeError(error), secrets);

	try {
		await host.run(
			asRoot(
				`umask 077 && mkdir -p ${quote(`${basePath}/data`)} && chmod 700 ${quote(basePath)} ${quote(`${basePath}/data`)}`,
			),
			{ signal: options.signal },
		);
		await host.writeFile(candidatePath, configYaml, 0o600);
	} catch (error) {
		throw new Error(`Failed to write the Vector config: ${redact(error)}`);
	}

	if (options.validate !== false) {
		try {
			await host.run(
				asRoot(
					`docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro -v ${quote(`${candidatePath}:/etc/vector/vector.yaml:ro`)} ${quote(await pinnedImage(host.docker(), VECTOR_IMAGE))} validate --skip-healthchecks /etc/vector/vector.yaml`,
				),
				{ signal: options.signal },
			);
		} catch (error) {
			await host
				.exec(asRoot(`rm -f ${quote(candidatePath)}`))
				.catch(() => undefined);
			throw new Error(
				`Generated Vector config failed validation, not applying it: ${redact(error)}`,
			);
		}
	}

	try {
		await host.run(asRoot(`mv ${quote(candidatePath)} ${quote(configPath)}`), {
			signal: options.signal,
		});
	} catch (error) {
		throw new Error(`Failed to apply the Vector config: ${redact(error)}`);
	}
	return configPath;
};

const statusCode = (error: unknown) =>
	(error as { statusCode?: number } | null)?.statusCode;

const deploySwarmService = async (
	docker: Dockerode,
	settings: CreateServiceOptions,
	log: Log,
	label: string,
) => {
	const service = docker.getService(settings.Name as string);
	let inspect: Awaited<ReturnType<typeof service.inspect>> | undefined;
	try {
		inspect = await service.inspect();
	} catch (error) {
		if (statusCode(error) !== 404) throw error;
	}
	if (!inspect) {
		try {
			await docker.createService(settings);
			log(`${label} started`);
		} catch (error) {
			if (statusCode(error) !== 409) throw error;
			log(`${label} service already exists, continuing`);
		}
		return;
	}
	// --watch-config reloads a changed file; only a changed container spec needs a restart.
	// Docker rewrites mount sources and drops defaults on inspect, so compare what we set.
	const containerSpecKey = (template: unknown) => {
		const spec = (template as { ContainerSpec?: ContainerSpec })?.ContainerSpec;
		return JSON.stringify({
			image: spec?.Image,
			args: spec?.Args,
			env: spec?.Env,
			mounts: spec?.Mounts?.map(
				(mount) => `${mount.Target}:${mount.ReadOnly ? "ro" : "rw"}`,
			),
		});
	};
	const specChanged =
		containerSpecKey(inspect.Spec?.TaskTemplate) !==
		containerSpecKey(settings.TaskTemplate);
	await service.update({
		version: Number(inspect.Version?.Index),
		...settings,
		TaskTemplate: {
			...settings.TaskTemplate,
			ForceUpdate:
				((inspect.Spec?.TaskTemplate as { ForceUpdate?: number } | undefined)
					?.ForceUpdate ?? 0) + (specChanged ? 1 : 0),
		},
	});
	log(`${label} updated`);
};

const removeSwarmService = async (docker: Dockerode, name: string) => {
	try {
		await docker.getService(name).remove();
	} catch (error) {
		if (statusCode(error) !== 404) throw error;
	}
};

// --watch-config misses a replaced file on some mounts, and SIGHUP makes Vector reload it anyway.
const reloadVectorConfig = async (docker: Dockerode) => {
	const containers = await docker.listContainers({
		filters: JSON.stringify({
			label: [`com.docker.swarm.service.name=${VECTOR_SERVICE_NAME}`],
		}),
	});
	for (const container of containers) {
		try {
			await docker.getContainer(container.Id).kill({ signal: "SIGHUP" });
		} catch (error) {
			const code = statusCode(error);
			if (code !== 404 && code !== 409) throw error;
		}
	}
};

export const vectorServiceSettings = (image: string): CreateServiceOptions => ({
	Name: VECTOR_SERVICE_NAME,
	Labels: { "panara-cloud.managed": "true" },
	TaskTemplate: {
		ContainerSpec: {
			Image: image,
			Args: ["--config", VECTOR_CONFIG_CONTAINER_PATH, "--watch-config"],
			Env: ["PROCFS_ROOT=/host/proc", "SYSFS_ROOT=/host/sys"],
			Mounts: [
				{
					Type: "bind",
					Source: "/var/run/docker.sock",
					Target: "/var/run/docker.sock",
					ReadOnly: true,
				},
				{
					Type: "bind",
					Source: VECTOR_PATH,
					Target: VECTOR_CONFIG_CONTAINER_DIR,
					ReadOnly: true,
				},
				{
					Type: "bind",
					Source: `${VECTOR_PATH}/data`,
					Target: VECTOR_DATA_DIR_CONTAINER,
					ReadOnly: false,
				},
				{ Type: "bind", Source: "/proc", Target: "/host/proc", ReadOnly: true },
				{ Type: "bind", Source: "/sys", Target: "/host/sys", ReadOnly: true },
			],
		},
		Networks: [{ Target: "host" }],
		Placement: { Constraints: ["node.role==manager"] },
	},
	Mode: { Replicated: { Replicas: 1 } },
});

export const cadvisorServiceSettings = (
	image: string,
): CreateServiceOptions => ({
	Name: CADVISOR_SERVICE_NAME,
	Labels: { "panara-cloud.managed": "true" },
	TaskTemplate: {
		ContainerSpec: {
			Image: image,
			Args: [
				"--listen_ip=127.0.0.1",
				`--port=${CADVISOR_PORT}`,
				"--docker_only=true",
				"--store_container_labels=false",
				`--whitelisted_container_labels=${PANARA_CLOUD_LABELS.join(",")}`,
				`--housekeeping_interval=${METRICS_SCRAPE_INTERVAL_SECS}s`,
				"--storage_duration=1m0s",
				"--event_storage_event_limit=default=0",
				"--event_storage_age_limit=default=0",
				"--disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,oom_event,percpu,perf_event,process,referenced_memory,resctrl,sched,tcp,udp",
			],
			// The image healthcheck probes the default port and would make Swarm restart the task.
			HealthCheck: { Test: ["NONE"] },
			Mounts: [
				{ Type: "bind", Source: "/", Target: "/rootfs", ReadOnly: true },
				// /run holds both docker.sock and containerd.sock; /var/run is a symlink to it.
				{ Type: "bind", Source: "/run", Target: "/run", ReadOnly: true },
				{ Type: "bind", Source: "/sys", Target: "/sys", ReadOnly: true },
				{
					Type: "bind",
					Source: "/var/lib/docker",
					Target: "/var/lib/docker",
					ReadOnly: true,
				},
			],
		},
		Networks: [{ Target: "host" }],
		Placement: { Constraints: ["node.role==manager"] },
	},
	Mode: { Replicated: { Replicas: 1 } },
});

export const deployCadvisorService = async (host: Host, log: Log) =>
	deploySwarmService(
		host.docker(),
		cadvisorServiceSettings(await pinnedImage(host.docker(), CADVISOR_IMAGE)),
		log,
		"cAdvisor",
	);

export const removeCadvisorService = (host: Host) =>
	removeSwarmService(host.docker(), CADVISOR_SERVICE_NAME);

export const reconcileVectorAgent = async (
	host: Host,
	input: {
		configYaml: string;
		metrics: boolean;
		secrets: string[];
		signal?: AbortSignal;
	},
	log: Log,
) => {
	log("Validating and writing the Vector config");
	await syncVectorConfig(host, input.configYaml, input.secrets, {
		signal: input.signal,
	});
	const docker = host.docker();
	await deploySwarmService(
		docker,
		vectorServiceSettings(await pinnedImage(docker, VECTOR_IMAGE)),
		log,
		"Vector",
	);
	await reloadVectorConfig(docker);
	if (input.metrics) {
		await deployCadvisorService(host, log);
	} else {
		await removeCadvisorService(host);
	}
};

export const removeVectorAgent = async (host: Host, log: Log) => {
	const docker = host.docker();
	try {
		await removeSwarmService(docker, CADVISOR_SERVICE_NAME);
	} catch (error) {
		log(`Failed to remove cAdvisor: ${describeError(error)}`);
	}
	await removeSwarmService(docker, VECTOR_SERVICE_NAME);
	await host.run(asRoot(`rm -rf ${quote(VECTOR_PATH)}`));
	log("Vector agent removed");
};

export type VectorStatus = "running" | "not-running" | "stopped";

const serviceState = async (
	docker: Dockerode,
	name: string,
): Promise<VectorStatus> => {
	// listTasks returns [] instead of 404 for a missing service, so inspect first.
	try {
		await docker.getService(name).inspect();
	} catch (error) {
		if (statusCode(error) === 404) return "stopped";
		throw error;
	}
	const tasks = await docker.listTasks({
		filters: JSON.stringify({ service: [name], "desired-state": ["running"] }),
	});
	return tasks.some((task) => task.Status?.State === "running")
		? "running"
		: "not-running";
};

// The "vector" host snapshot: live state of both swarm services, read by the
// Logs & Metrics screen.
export const readVectorServices = async (host: Host) => {
	const docker = host.docker();
	return {
		vector: await serviceState(docker, VECTOR_SERVICE_NAME),
		cadvisor: await serviceState(docker, CADVISOR_SERVICE_NAME),
	};
};

export const inspectVectorStatus = async (
	host: Host,
	requireCadvisor: boolean,
): Promise<VectorStatus> => {
	const docker = host.docker();
	const vector = await serviceState(docker, VECTOR_SERVICE_NAME);
	if (vector !== "running" || !requireCadvisor) return vector;
	const cadvisor = await serviceState(docker, CADVISOR_SERVICE_NAME);
	return cadvisor === "running" ? "running" : "not-running";
};
