import type { CreateServiceOptions } from "dockerode";
import type { Host } from "../host/types";
import { assertBindMountsAllowed } from "../lib/bindPolicy";
import { assertSwarmSpecAllowed } from "../lib/servicePolicy";
import {
	calculateResources,
	generateMounts,
	generateServiceConfig,
	inSequence,
	type Mount,
	type PanaraCloudLabels,
	panaraCloudLabels,
	type Resources,
	type SwarmSettings,
} from "../lib/swarm";

export type ServicePort = {
	publishedPort: number;
	targetPort: number;
	protocol: "tcp" | "udp";
	publishMode: "ingress" | "host";
};

export type ServiceInput = {
	appName: string;
	image: string;
	// Resolved KEY=value pairs.
	env: string[];
	command: string | null;
	args: string[];
	replicas: number;
	swarm: SwarmSettings;
	resources: Resources;
	mounts: Mount[];
	ports: ServicePort[];
	labels: PanaraCloudLabels;
	auth?: { username: string; password: string; serveraddress: string };
	// The job's `trusted` flag; see lib/bindPolicy.ts.
	trusted: boolean;
};

// Swarm service spec for an application.
export const buildServiceSpec = (input: ServiceInput): CreateServiceOptions => {
	const config = generateServiceConfig({
		...input.swarm,
		replicas: input.replicas,
		hasMounts: input.mounts.length > 0,
	});
	const command = input.command?.trim();
	return {
		...(input.auth ? { authconfig: input.auth } : {}),
		Name: input.appName,
		Labels: panaraCloudLabels(input.labels),
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck: config.HealthCheck,
				Image: input.image,
				Env: input.env,
				Mounts: generateMounts(input.appName, input.mounts),
				...(config.StopGracePeriod !== undefined && {
					StopGracePeriod: config.StopGracePeriod,
				}),
				...(command && { Command: command.split(" ").filter(Boolean) }),
				...(input.args.length > 0 && { Args: input.args }),
				...(config.Ulimits && { Ulimits: config.Ulimits }),
				Labels: { ...config.Labels, ...panaraCloudLabels(input.labels) },
			},
			Networks: config.Networks,
			RestartPolicy: config.RestartPolicy,
			Placement: config.Placement,
			Resources: calculateResources(input.resources),
		},
		Mode: config.Mode,
		RollbackConfig: config.RollbackConfig,
		UpdateConfig: config.UpdateConfig,
		EndpointSpec: config.EndpointSpec ?? {
			Ports: input.ports.map((port) => ({
				PublishMode: port.publishMode,
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
	} as CreateServiceOptions;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const statusCode = (error: unknown) =>
	(error as { statusCode?: number }).statusCode;

// Creates the service or rolls it to the new spec. Registry credentials are
// passed explicitly so Swarm can pull private images on every node; labels
// added to the service outside Panara Cloud are kept.
export const upsertApplicationService = async (
	host: Host,
	spec: CreateServiceOptions,
): Promise<{ action: "created" | "updated"; forceUpdate: number }> => {
	const docker = host.docker();
	const { authconfig, ...settings } = spec as CreateServiceOptions & {
		authconfig?: object;
	};
	const name = settings.Name as string;
	try {
		await docker.getService(name).inspect();
	} catch (error) {
		if (statusCode(error) !== 404) throw error;
		await docker.createService(
			(authconfig ?? {}) as Parameters<typeof docker.createService>[0],
			settings,
		);
		return { action: "created", forceUpdate: 0 };
	}
	const forceUpdate = await inSequence(async () => {
		const inspect = await docker.getService(name).inspect();
		const next = (inspect.Spec?.TaskTemplate?.ForceUpdate ?? 0) + 1;
		await docker.getService(name).update({
			...settings,
			...(authconfig ? { authconfig } : {}),
			version: Number.parseInt(inspect.Version.Index, 10),
			Labels: { ...(inspect.Spec?.Labels ?? {}), ...(settings.Labels ?? {}) },
			TaskTemplate: { ...settings.TaskTemplate, ForceUpdate: next },
		});
		return next;
	});
	return { action: "updated", forceUpdate };
};

// Swarm only reports a task it can't place (e.g. not enough memory) or start
// (e.g. a bind mount whose host path is missing) on the task itself, so watch
// the new tasks briefly and surface that error. Rejected tasks already have
// desired state "shutdown" while Swarm keeps retrying with new ones.
export const waitForScheduling = async (
	host: Host,
	appName: string,
	forceUpdate: number,
	timeoutMs = 5_000,
) => {
	const docker = host.docker();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const tasks = await docker.listTasks({
			filters: JSON.stringify({ service: [appName] }),
		});
		const fresh = tasks.filter(
			(task) => (task.Spec?.ForceUpdate ?? 0) === forceUpdate,
		);
		const rejected = fresh.find((task) => task.Status?.State === "rejected");
		if (rejected) {
			throw new Error(
				`Swarm rejected the new version: ${rejected.Status?.Err ?? "unknown error"}`,
			);
		}
		const current = fresh.filter((task) => task.DesiredState === "running");
		const unscheduled = current.find(
			(task) => task.Status?.State === "pending" && task.Status?.Err,
		);
		if (unscheduled) {
			throw new Error(
				`Swarm could not start the new version: ${unscheduled.Status?.Err}. Lower the memory/CPU reservation or free resources on the server.`,
			);
		}
		if (
			current.length > 0 &&
			current.every(
				(task) =>
					!["new", "allocated", "pending"].includes(task.Status?.State ?? ""),
			)
		) {
			return;
		}
		await sleep(300);
	}
};

export const deployService = async (host: Host, input: ServiceInput) => {
	await assertBindMountsAllowed(
		host,
		input.appName,
		input.mounts,
		input.trusted,
	);
	const spec = buildServiceSpec(input);
	assertSwarmSpecAllowed(spec, input.trusted);
	const result = await upsertApplicationService(host, spec);
	await waitForScheduling(host, input.appName, result.forceUpdate);
	return result;
};
