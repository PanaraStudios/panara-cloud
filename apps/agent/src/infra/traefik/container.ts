import type Dockerode from "dockerode";
import type { Host } from "../../host/types";
import { NETWORK_NAME, paths, TRAEFIK_CONTAINER } from "../../lib/constants";
import { pinnedImage } from "../../lib/pinnedImage";
import {
	acmeAccountEmail,
	CONTAINER_DYNAMIC_PATH,
	MAIN_CONFIG_PATH,
	TRAEFIK_DASHBOARD_PORT,
	TRAEFIK_HTTP3_PORT,
	TRAEFIK_IMAGE,
	TRAEFIK_PORT,
	TRAEFIK_SSL_PORT,
	TRAEFIK_VERSION,
	updateLetsEncryptEmail,
} from "./config";

const NEXT_CONTAINER = `${TRAEFIK_CONTAINER}-next`;
const PREVIOUS_CONTAINER = `${TRAEFIK_CONTAINER}-previous`;

export type TraefikPort = {
	targetPort: number;
	publishedPort: number;
	protocol: "tcp" | "udp" | "sctp";
};

export type TraefikOptions = {
	// null keeps the running container's environment.
	env: string[] | null;
	additionalPorts: TraefikPort[];
	dashboard: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inspect = (docker: Dockerode, name: string) =>
	docker
		.getContainer(name)
		.inspect()
		.catch(() => null);

const BASE_PORT_KEYS = new Set([
	`${TRAEFIK_PORT}/tcp`,
	`${TRAEFIK_SSL_PORT}/tcp`,
	`${TRAEFIK_HTTP3_PORT}/udp`,
]);

export type TraefikState = {
	exists: boolean;
	state: string | null;
	image: string | null;
	version: string | null;
	recommendedVersion: string;
	versionStatus: "current" | "outdated" | "newer" | "unknown" | "custom";
	env: string[];
	additionalPorts: TraefikPort[];
	dashboard: boolean;
};

const compareVersions = (a: string, b: string): number => {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
};

const OFFICIAL_TRAEFIK_REPOSITORIES = new Set([
	"traefik",
	"library/traefik",
	"docker.io/traefik",
	"docker.io/library/traefik",
]);

// Custom-image check: anything but the official image (any tag)
// is left alone by updates.
export const isOfficialTraefikImage = (image: string) => {
	const withoutDigest = image.split("@")[0] ?? "";
	const slash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.lastIndexOf(":");
	const repository =
		colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
	return OFFICIAL_TRAEFIK_REPOSITORIES.has(repository.toLowerCase());
};

// Env the image itself sets; re-passing it would pin stale values.
const isImageEnv = (entry: string) => entry.startsWith("PATH=");

export const readTraefikState = async (host: Host): Promise<TraefikState> => {
	const info = await inspect(host.docker(), TRAEFIK_CONTAINER);
	if (!info) {
		return {
			exists: false,
			state: null,
			image: null,
			version: null,
			recommendedVersion: TRAEFIK_VERSION,
			versionStatus: "unknown",
			env: [],
			additionalPorts: [],
			dashboard: false,
		};
	}
	const image = info.Config.Image;
	const version =
		image.replace(/@.*/, "").split(":").at(-1)?.replace(/^v/, "") ?? null;
	const bindings = info.HostConfig.PortBindings ?? {};
	const additionalPorts: TraefikPort[] = [];
	let dashboard = false;
	for (const [key, binds] of Object.entries(bindings)) {
		const [target, protocol = "tcp"] = key.split("/");
		const published = Number(
			(binds as { HostPort?: string }[] | null)?.[0]?.HostPort,
		);
		if (BASE_PORT_KEYS.has(key) || !published) continue;
		if (Number(target) === TRAEFIK_DASHBOARD_PORT && protocol === "tcp") {
			dashboard = true;
			continue;
		}
		additionalPorts.push({
			targetPort: Number(target),
			publishedPort: published,
			protocol: protocol as TraefikPort["protocol"],
		});
	}
	const cmp =
		version && /^\d/.test(version)
			? compareVersions(version, TRAEFIK_VERSION)
			: null;
	const custom = !isOfficialTraefikImage(image);
	return {
		exists: true,
		state: info.State.Status,
		image,
		version,
		recommendedVersion: TRAEFIK_VERSION,
		versionStatus: custom
			? "custom"
			: cmp === null
				? "unknown"
				: cmp < 0
					? "outdated"
					: cmp > 0
						? "newer"
						: "current",
		env: (info.Config.Env ?? []).filter((entry) => !isImageEnv(entry)),
		additionalPorts,
		dashboard,
	};
};

export const ensureTraefikImage = (host: Host): Promise<string> =>
	pinnedImage(host.docker(), TRAEFIK_IMAGE);

// Undoes a recreate interrupted mid-way (agent crash between rename steps).
export const restoreInterruptedTraefik = async (host: Host): Promise<void> => {
	const docker = host.docker();
	const nextInfo = await inspect(docker, NEXT_CONTAINER);
	const backupInfo = await inspect(docker, PREVIOUS_CONTAINER);
	if (!nextInfo && !backupInfo) return;
	let currentInfo = await inspect(docker, TRAEFIK_CONTAINER);
	if (currentInfo?.State.Status === "created" && backupInfo) {
		await docker.getContainer(currentInfo.Id).remove({ force: true });
		currentInfo = null;
	}
	if (currentInfo) {
		if (nextInfo && !currentInfo.State.Running) {
			await docker.getContainer(currentInfo.Id).start();
		}
	} else if (backupInfo) {
		const backup = docker.getContainer(backupInfo.Id);
		if (backupInfo.State.Running) await backup.stop().catch(() => {});
		try {
			await backup.rename({ name: TRAEFIK_CONTAINER });
		} finally {
			await backup.start().catch(() => {});
		}
	}
	if (nextInfo) await docker.getContainer(nextInfo.Id).remove({ force: true });
};

const assertPortsFree = async (docker: Dockerode, ports: number[]) => {
	const containers = await docker.listContainers();
	for (const container of containers) {
		const name = container.Names[0]?.replace(/^\//, "") ?? container.Id;
		if (name.startsWith(TRAEFIK_CONTAINER)) continue;
		for (const port of container.Ports ?? []) {
			if (port.PublicPort && ports.includes(port.PublicPort)) {
				throw new Error(`Port ${port.PublicPort} is already in use by ${name}`);
			}
		}
	}
};

// restart: always hides a container that exits on start.
const waitUntilStable = async (container: Dockerode.Container) => {
	await sleep(3000);
	const first = await container.inspect();
	await sleep(2000);
	const second = await container.inspect();
	if (
		second.State.Running &&
		second.State.StartedAt === first.State.StartedAt
	) {
		return;
	}
	const logs = (await container
		.logs({ stdout: true, stderr: true, tail: 5 })
		.catch(() => null)) as Buffer | null;
	const lastLine = logs ? lastLogLine(logs) : "";
	throw new Error(
		`The new Traefik container stopped right after starting${lastLine ? `: ${lastLine}` : ""}`,
	);
};

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Non-TTY container logs come in frames with an 8-byte header.
export const lastLogLine = (logs: Buffer): string => {
	let text = "";
	for (let offset = 0; offset + 8 <= logs.length; ) {
		const size = logs.readUInt32BE(offset + 4);
		text += logs.subarray(offset + 8, offset + 8 + size).toString();
		offset += 8 + size;
	}
	const lines = text.replace(ANSI_COLOR, "").trim().split("\n");
	return (lines.at(-1) ?? "").trim().slice(0, 300);
};

export const containerSettings = (
	env: string[],
	options: TraefikOptions,
	image: string,
): Dockerode.ContainerCreateOptions => {
	const exposedPorts: Record<string, object> = {};
	const portBindings: Record<string, { HostPort: string; HostIp?: string }[]> =
		{};
	const bind = (
		target: number,
		published: number,
		protocol: string,
		hostIp?: string,
	) => {
		const key = `${target}/${protocol}`;
		exposedPorts[key] = {};
		portBindings[key] = [
			{ HostPort: String(published), ...(hostIp ? { HostIp: hostIp } : {}) },
		];
	};
	bind(TRAEFIK_PORT, TRAEFIK_PORT, "tcp");
	bind(TRAEFIK_SSL_PORT, TRAEFIK_SSL_PORT, "tcp");
	bind(TRAEFIK_HTTP3_PORT, TRAEFIK_HTTP3_PORT, "udp");
	if (options.dashboard) {
		bind(TRAEFIK_DASHBOARD_PORT, TRAEFIK_DASHBOARD_PORT, "tcp", "127.0.0.1");
	}
	for (const port of options.additionalPorts) {
		bind(port.targetPort, port.publishedPort, port.protocol);
	}
	return {
		name: NEXT_CONTAINER,
		Image: image,
		Env: env,
		Labels: { "panara-cloud.managed": "true" },
		ExposedPorts: exposedPorts,
		NetworkingConfig: { EndpointsConfig: { [NETWORK_NAME]: {} } },
		HostConfig: {
			RestartPolicy: { Name: "always" },
			Binds: [
				`${MAIN_CONFIG_PATH}:/etc/traefik/traefik.yml`,
				`${paths.traefikDynamic}:${CONTAINER_DYNAMIC_PATH}`,
				"/var/run/docker.sock:/var/run/docker.sock",
			],
			PortBindings: portBindings,
		},
	};
};

// Recreates the standalone Traefik container: the new one is created first
// and the old one kept aside until the new one stays up, so a bad config or
// port clash restores the previous Traefik.
export const recreateTraefik = async (
	host: Host,
	options: TraefikOptions,
	log: (line: string) => void = () => {},
): Promise<void> => {
	const docker = host.docker();
	await restoreInterruptedTraefik(host);
	log(`Ensuring image ${TRAEFIK_IMAGE}`);
	const image = await ensureTraefikImage(host);

	const currentInfo = await inspect(docker, TRAEFIK_CONTAINER);
	const current = currentInfo ? docker.getContainer(currentInfo.Id) : null;
	const env =
		options.env ??
		(currentInfo?.Config.Env ?? []).filter((e) => !isImageEnv(e));
	const extraPorts = [
		...(options.dashboard ? [TRAEFIK_DASHBOARD_PORT] : []),
		...options.additionalPorts.map((p) => p.publishedPort),
	];
	if (extraPorts.length > 0) await assertPortsFree(docker, extraPorts);
	const otherNetworks = Object.entries(
		currentInfo?.NetworkSettings?.Networks ?? {},
	).filter(([name]) => name !== NETWORK_NAME);

	let created: Dockerode.Container | undefined;
	let movedAside = false;
	try {
		await docker
			.getContainer(NEXT_CONTAINER)
			.remove({ force: true })
			.catch(() => {});
		created = await docker.createContainer(
			containerSettings(env, options, image),
		);
		for (const [, endpoint] of otherNetworks) {
			await docker.getNetwork(endpoint.NetworkID).connect({
				Container: created.id,
				EndpointConfig: { Aliases: endpoint.Aliases ?? undefined },
			});
		}
		if (current) {
			await docker
				.getContainer(PREVIOUS_CONTAINER)
				.remove({ force: true })
				.catch(() => {});
			log("Stopping the current Traefik");
			await current.stop().catch(() => {});
			await current.rename({ name: PREVIOUS_CONTAINER });
			movedAside = true;
			await sleep(2000);
		}
		await created.rename({ name: TRAEFIK_CONTAINER });
		log("Starting Traefik");
		await created.start();
		await waitUntilStable(created);
	} catch (error) {
		if (!current) {
			await created?.remove({ force: true }).catch(() => {});
			throw error;
		}
		if (!movedAside) {
			const now = await current.inspect().catch(() => null);
			if (currentInfo?.State.Running && !now?.State.Running)
				await current.start();
			await created?.remove({ force: true }).catch(() => {});
			throw error;
		}
		await created?.remove({ force: true }).catch(() => {});
		const reason = error instanceof Error ? error.message : String(error);
		try {
			await current.rename({ name: TRAEFIK_CONTAINER });
			if (currentInfo?.State.Running) await current.start();
		} catch (restoreError) {
			throw new Error(
				`${reason}. Restoring the previous Traefik also failed: ${restoreError instanceof Error ? restoreError.message : restoreError}`,
			);
		}
		throw new Error(`${reason}. The previous Traefik was restored.`);
	}
	await current?.remove({ force: true }).catch(() => {});
	log(`Traefik ${TRAEFIK_VERSION} is running ✅`);
};

// Creates Traefik only when it doesn't exist (server setup).
export const ensureTraefik = async (
	host: Host,
	options: TraefikOptions,
	log: (line: string) => void = () => {},
): Promise<"created" | "exists"> => {
	await restoreInterruptedTraefik(host);
	if (await inspect(host.docker(), TRAEFIK_CONTAINER)) {
		log("Traefik already exists ✅");
		return "exists";
	}
	await recreateTraefik(host, options, log);
	return "created";
};

export const restartTraefik = async (host: Host): Promise<void> => {
	await host.docker().getContainer(TRAEFIK_CONTAINER).restart();
};

// Saves the Let's Encrypt email, and restarts Traefik only when that does
// something. The email is in Traefik's static configuration, read at start,
// and Traefik uses it for one thing: registering its account, the first time
// it requests a certificate (pkg/provider/acme/provider.go, initAccount, in
// Traefik 3.7). Once acme.json holds an account, Traefik keeps it whatever
// the configuration says, so a restart would stop every application for a
// few seconds and change nothing. Before the first registration the restart
// is what makes Traefik register with this address; call this before the
// panel's route is written, since the route is what triggers the request.
export const applyLetsEncryptEmail = async (
	host: Host,
	email: string,
	log: (line: string) => void,
	traefik: {
		exists: () => Promise<boolean>;
		restart: () => Promise<void>;
	} = {
		exists: async () => (await readTraefikState(host)).exists,
		restart: () => restartTraefik(host),
	},
): Promise<"unchanged" | "saved" | "restarted"> => {
	if (!(await updateLetsEncryptEmail(host, email))) return "unchanged";
	const registered = await acmeAccountEmail(host);
	if (registered) {
		log(
			`Let's Encrypt email saved. Traefik is already registered with Let's Encrypt (as ${registered}) and keeps that account, so it is not restarted`,
		);
		return "saved";
	}
	if (!(await traefik.exists())) return "saved";
	log(
		"Let's Encrypt email saved; restarting Traefik so it registers with it. Applications do not answer for a few seconds",
	);
	await traefik.restart();
	return "restarted";
};
