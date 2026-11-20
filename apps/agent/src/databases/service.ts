import type { CreateServiceOptions } from "dockerode";
import type { Host } from "../host/types";
import { assertBindMountsAllowed } from "../lib/bindPolicy";
import { PANARA_CLOUD_LABEL } from "../lib/constants";
import { prepareEnvironmentVariables } from "../lib/env";
import { assertSwarmSpecAllowed } from "../lib/servicePolicy";
import { quote } from "../lib/shell";
import {
	calculateResources,
	generateMounts,
	generateServiceConfig,
	type Mount,
	panaraCloudLabels,
	type Resources,
	removeService,
	type SwarmSettings,
	upsertService,
	writeFileMounts,
} from "../lib/swarm";

export type Engine =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export type DatabaseServiceInput = SwarmSettings &
	Resources & {
		databaseId: string;
		organizationId: string;
		projectId: string;
		environmentId: string;
		engine: Engine;
		name: string;
		appName: string;
		dockerImage: string;
		command?: string;
		args?: string[];
		replicas: number;
		externalPort?: number;
		externalGRPCPort?: number;
		externalAdminPort?: number;
		replicaSets?: boolean;
		sqldNode?: "primary" | "replica";
		sqldPrimaryUrl?: string;
		enableNamespaces?: boolean;
		// Dotenv text: the service's own env plus shared project/environment env.
		env: string;
		projectEnv: string;
		environmentEnv: string;
		credentials: {
			databaseName?: string;
			databaseUser?: string;
			password: string;
			rootPassword?: string;
		};
		mounts: Mount[];
	};

export const ENGINE_PORTS: Record<Engine, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
	libsql: 8080,
};

const LIBSQL_DEFAULT_COMMAND =
	"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000";

const withEnv = (defaults: string[], env: string) =>
	[...defaults, ...(env.trim() ? [env] : [])].join("\n");

// The engine's own default variables first, then the
// user's env, so user values override defaults with the same key.
export const engineEnv = (input: DatabaseServiceInput): string => {
	const { databaseName, databaseUser, password, rootPassword } =
		input.credentials;
	switch (input.engine) {
		case "postgres":
			return withEnv(
				[
					`POSTGRES_DB="${databaseName}"`,
					`POSTGRES_USER="${databaseUser}"`,
					`POSTGRES_PASSWORD="${password}"`,
				],
				input.env,
			);
		case "mysql":
			return withEnv(
				databaseUser !== "root"
					? [
							`MYSQL_USER="${databaseUser}"`,
							`MYSQL_DATABASE="${databaseName}"`,
							`MYSQL_PASSWORD="${password}"`,
							`MYSQL_ROOT_PASSWORD="${rootPassword}"`,
						]
					: [
							`MYSQL_DATABASE="${databaseName}"`,
							`MYSQL_ROOT_PASSWORD="${rootPassword}"`,
						],
				input.env,
			);
		case "mariadb":
			return withEnv(
				[
					`MARIADB_DATABASE="${databaseName}"`,
					`MARIADB_USER="${databaseUser}"`,
					`MARIADB_PASSWORD="${password}"`,
					`MARIADB_ROOT_PASSWORD="${rootPassword}"`,
				],
				input.env,
			);
		case "mongo":
			return withEnv(
				[
					`MONGO_INITDB_ROOT_USERNAME="${databaseUser}"`,
					`MONGO_INITDB_ROOT_PASSWORD="${password}"`,
					...(input.replicaSets ? ["MONGO_INITDB_DATABASE=admin"] : []),
				],
				input.env,
			);
		case "redis":
			return withEnv([`REDIS_PASSWORD="${password}"`], input.env);
		case "libsql": {
			const basicAuth = Buffer.from(
				`${databaseUser}:${password}`,
				"utf-8",
			).toString("base64");
			const env = withEnv(
				[
					`SQLD_NODE="${input.sqldNode ?? "primary"}"`,
					`SQLD_HTTP_AUTH="basic:${basicAuth}"`,
				],
				input.env,
			);
			return input.sqldNode === "replica"
				? `${env}\nSQLD_PRIMARY_URL="${input.sqldPrimaryUrl ?? ""}"`
				: env;
		}
	}
};

// Replica-set bootstrap: start mongod with --replSet,
// initiate rs0 once, and create the root user after becoming primary.
const mongoReplicaSetScript = (input: DatabaseServiceInput) => `
#!/bin/bash
mongod --port 27017 --replSet rs0 --bind_ip_all &
MONGOD_PID=$!
while ! mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
	sleep 2
done
REPLICA_STATUS=$(mongosh --quiet --eval "rs.status().ok || 0")
if [ "$REPLICA_STATUS" != "1" ]; then
	echo "Initializing replica set..."
	mongosh --eval '
	rs.initiate({
		_id: "rs0",
		members: [{ _id: 0, host: "${input.appName}:27017", priority: 1 }]
	});
	while (!rs.isMaster().ismaster) {
		sleep(1000);
	}
	db.getSiblingDB("admin").createUser({
		user: process.env.MONGO_INITDB_ROOT_USERNAME,
		pwd: process.env.MONGO_INITDB_ROOT_PASSWORD,
		roles: ["root"]
	});
	'
else
	echo "Replica set already initialized."
fi
${input.command ?? "wait $MONGOD_PID"}`;

const commandFor = (
	input: DatabaseServiceInput,
): { Command?: string[]; Args?: string[] } => {
	const custom = {
		...(input.command ? { Command: input.command.split(" ") } : {}),
		...(input.args?.length ? { Args: input.args } : {}),
	};
	switch (input.engine) {
		case "mongo":
			return input.replicaSets
				? { Command: ["/bin/bash"], Args: ["-c", mongoReplicaSetScript(input)] }
				: custom;
		case "redis":
			// The password is read from the env at runtime rather than baked into
			// the service's args, where `docker service inspect` would show it.
			return input.command || input.args?.length
				? custom
				: {
						Command: ["/bin/sh"],
						Args: ["-c", 'exec redis-server --requirepass "$REDIS_PASSWORD"'],
					};
		case "libsql": {
			const command = `${input.command ?? LIBSQL_DEFAULT_COMMAND}${input.enableNamespaces ? " --enable-namespaces" : ""}`;
			return { Command: ["/bin/sh"], Args: ["-c", command] };
		}
		default:
			return custom;
	}
};

const publishedPorts = (input: DatabaseServiceInput) => {
	const ports: [number | undefined, number][] =
		input.engine === "libsql"
			? [
					[input.externalPort, 8080],
					[input.externalGRPCPort, 5001],
					[input.externalAdminPort, 5000],
				]
			: [[input.externalPort, ENGINE_PORTS[input.engine]]];
	return ports.flatMap(([published, target]) =>
		published
			? [
					{
						Protocol: "tcp" as const,
						TargetPort: target,
						PublishedPort: published,
						PublishMode: "host" as const,
					},
				]
			: [],
	);
};

export const buildServiceSpec = (
	input: DatabaseServiceInput,
): CreateServiceOptions => {
	const config = generateServiceConfig({
		...input,
		hasMounts: input.mounts.length > 0,
	});
	const labels = panaraCloudLabels({
		organizationId: input.organizationId,
		projectId: input.projectId,
		environmentId: input.environmentId,
		serviceKind: "database",
		serviceId: input.databaseId,
		serviceName: input.name,
	});
	const env = prepareEnvironmentVariables(
		engineEnv(input),
		input.projectEnv,
		input.environmentEnv,
	);
	return {
		Name: input.appName,
		Labels: { ...labels, "panara-cloud.database.engine": input.engine },
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck: config.HealthCheck,
				Image: input.dockerImage,
				Env: env,
				// Volumes created for the service carry the Panara Cloud label too.
				Mounts: generateMounts(input.appName, input.mounts).map((mount) =>
					mount.Type === "volume"
						? {
								...mount,
								VolumeOptions: { Labels: { [PANARA_CLOUD_LABEL]: "true" } },
							}
						: mount,
				),
				StopGracePeriod:
					config.StopGracePeriod ??
					(input.engine === "postgres" ? 30_000_000_000 : undefined),
				...commandFor(input),
				...(config.Ulimits ? { Ulimits: config.Ulimits } : {}),
				Labels: { ...config.Labels, ...labels },
			},
			Networks: config.Networks,
			RestartPolicy: config.RestartPolicy,
			Placement: config.Placement,
			Resources: calculateResources(input),
		},
		Mode: config.Mode,
		RollbackConfig: config.RollbackConfig,
		// dnsrr keeps the service reachable by name on the overlay network while
		// published ports bind on the host.
		EndpointSpec: config.EndpointSpec ?? {
			Mode: "dnsrr",
			Ports: publishedPorts(input),
		},
		// Two tasks must never share a data directory, so the old task stops
		// before the new one starts.
		UpdateConfig: input.updateConfigSwarm ?? {
			Parallelism: 1,
			Order: "stop-first",
			FailureAction: "rollback",
		},
	} as CreateServiceOptions;
};

type Log = (text: string) => void;

export const pullImage = async (
	host: Host,
	image: string,
	log: Log,
	signal?: AbortSignal,
) => {
	log(`Pulling ${image}\n`);
	await host.run(`docker pull ${quote(image)}`, {
		signal,
		onOutput: (text) => log(text),
	});
};

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Cancelled"));
			},
			{ once: true },
		);
	});

// Waits until the service runs its desired number of tasks, reporting the
// last task error on timeout.
export const waitForConvergence = async (
	host: Host,
	appName: string,
	options: { timeoutMs?: number; signal?: AbortSignal; log?: Log } = {},
) => {
	const docker = host.docker();
	const deadline = Date.now() + (options.timeoutMs ?? 180_000);
	let lastState = "unknown";
	for (;;) {
		const info = await docker.getService(appName).inspect();
		const desired = info.Spec?.Mode?.Replicated?.Replicas ?? 1;
		const tasks = await docker.listTasks({
			filters: JSON.stringify({ service: [appName] }),
		});
		const current = tasks.filter((task) => task.DesiredState === "running");
		const running = current.filter(
			(task) => task.Status?.State === "running",
		).length;
		if (running >= desired) return;
		const failed = tasks.find((task) =>
			["failed", "rejected"].includes(task.Status?.State ?? ""),
		);
		lastState =
			failed?.Status?.Err ??
			failed?.Status?.State ??
			current[0]?.Status?.State ??
			lastState;
		if (Date.now() >= deadline) {
			throw new Error(
				`Service ${appName} did not converge: ${running}/${desired} tasks running (last state: ${lastState})`,
			);
		}
		await sleep(2_000, options.signal);
	}
};

export const deployDatabase = async (
	host: Host,
	input: DatabaseServiceInput,
	options: { log: Log; signal?: AbortSignal; trusted: boolean },
) => {
	await assertBindMountsAllowed(
		host,
		input.appName,
		input.mounts,
		options.trusted,
	);
	const spec = buildServiceSpec(input);
	assertSwarmSpecAllowed(spec, options.trusted);
	await pullImage(host, input.dockerImage, options.log, options.signal);
	await writeFileMounts(host, input.appName, input.mounts);
	const result = await upsertService(host.docker(), spec);
	options.log(`Service ${input.appName} ${result}\n`);
	if (input.replicas > 0) {
		await waitForConvergence(host, input.appName, {
			signal: options.signal,
			log: options.log,
		});
	}
	options.log("Deployment completed successfully!\n");
};

// Start/stop: scale the swarm service to 1 or 0.
export const scaleDatabase = async (
	host: Host,
	appName: string,
	replicas: number,
	signal?: AbortSignal,
) => {
	await host.run(
		`docker service scale --detach ${quote(`${appName}=${replicas}`)}`,
		{ signal },
	);
};

export const waitForContainersGone = async (
	host: Host,
	appName: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
) => {
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	for (;;) {
		const output = await host.run(
			`docker ps -aq --filter ${quote(`label=com.docker.swarm.service.name=${appName}`)}`,
			{ signal: options.signal },
		);
		if (!output.trim()) return;
		if (Date.now() >= deadline) {
			throw new Error(`Containers of ${appName} are still present`);
		}
		await sleep(1_000, options.signal);
	}
};

export const removeVolumes = async (
	host: Host,
	volumeNames: string[],
	log: Log,
	signal?: AbortSignal,
) => {
	for (const volume of volumeNames) {
		const result = await host.exec(
			`docker volume rm --force ${quote(volume)}`,
			{
				signal,
			},
		);
		log(
			result.code === 0
				? `Removed volume ${volume}\n`
				: `Could not remove volume ${volume}: ${result.output.trim()}\n`,
		);
	}
};

export const removeDatabase = async (
	host: Host,
	appName: string,
	volumeNames: string[],
	options: { log: Log; signal?: AbortSignal },
) => {
	await removeService(host.docker(), appName);
	options.log(`Removed service ${appName}\n`);
	await host.exec(
		`if [ -d ${quote(`/etc/panara-cloud/applications/${appName}`)} ]; then rm -rf ${quote(`/etc/panara-cloud/applications/${appName}`)} 2>/dev/null || sudo -n rm -rf ${quote(`/etc/panara-cloud/applications/${appName}`)}; fi`,
		{ signal: options.signal },
	);
	if (volumeNames.length > 0) {
		await waitForContainersGone(host, appName, { signal: options.signal });
		await removeVolumes(host, volumeNames, options.log, options.signal);
	}
};

// Rebuild: drop the service and its data volumes, then
// deploy again from scratch.
export const rebuildDatabase = async (
	host: Host,
	input: DatabaseServiceInput,
	options: { log: Log; signal?: AbortSignal; trusted: boolean },
) => {
	// Checked before anything is removed, not only in deployDatabase.
	assertSwarmSpecAllowed(buildServiceSpec(input), options.trusted);
	await assertBindMountsAllowed(
		host,
		input.appName,
		input.mounts,
		options.trusted,
	);
	await removeService(host.docker(), input.appName);
	options.log(`Removed service ${input.appName}\n`);
	await waitForContainersGone(host, input.appName, { signal: options.signal });
	await removeVolumes(
		host,
		input.mounts.flatMap((mount) =>
			mount.type === "volume" ? [mount.volumeName] : [],
		),
		options.log,
		options.signal,
	);
	await deployDatabase(host, input, options);
};
