import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type Dockerode from "dockerode";
import type { Host } from "../host/types";
import { NETWORK_NAME } from "../lib/constants";
import { quote } from "../lib/shell";
import { drainTimeoutMs } from "../shutdown";
import { runScript } from "./shell";

// The panel's own services. Production packaging isn't fixed yet, so the
// agent learns them from its environment:
//   PANARA_CLOUD_IMAGES       service=repository pairs, comma separated
//                             (Swarm services or containers on the panel host;
//                             list the agent's own service last)
//   PANARA_CLOUD_VERSION      running version (default: the agent's version)
//   PANARA_CLOUD_RELEASE_TAG  release channel, "latest" (default) or a moving
//                             tag such as "canary"
//   PANARA_CLOUD_VERSION_URL  where to read the newest version (JSON with
//                             `version`/`tag_name`, or plain text); default:
//                             the tags of the first repository in the registry
//   PANARA_CLOUD_WEB_SERVICE  service that publishes the panel port
//                             (default: the first service)
//   PANARA_CLOUD_PANEL_PORT   default 3000
//   PANARA_CLOUD_MIGRATOR     service whose image, at the new version, runs
//                             `migrate` (Convex functions deploy + data
//                             migrations) before any service is rolled; needs
//                             PANARA_CLOUD_CONVEX_ADMIN_KEY(_FILE) and
//                             PANARA_CLOUD_CONVEX_SELF_HOSTED_URL
//   PANARA_CLOUD_AGENT_SERVICE the agent's own service (default: the
//                             migrator); an Update gives it a stop grace
//                             period that covers AGENT_DRAIN_TIMEOUT_SECONDS
export type PanelService = { name: string; repository: string };

export type PanelConfig = {
	version: string;
	releaseTag: string;
	services: PanelService[];
	webService: string | null;
	panelPort: number;
	versionUrl: string | null;
	agentService: string | null;
	agentStopGraceSeconds: number;
	migrator: {
		service: string;
		convexUrl: string | null;
		adminKeyFile: string | null;
		inlineAdminKey: boolean;
	} | null;
};

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._/:-]{0,254}$/i;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const agentVersion = () => {
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
};

// A repository given with a tag ("ghcr.io/acme/web:1.0") keeps only the
// repository part; the tag comes from the version being installed.
const stripTag = (repository: string) => {
	const slash = repository.lastIndexOf("/");
	const colon = repository.lastIndexOf(":");
	return colon > slash ? repository.slice(0, colon) : repository;
};

export const parsePanelImages = (value: string | undefined): PanelService[] =>
	(value ?? "")
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((entry) => {
			const index = entry.indexOf("=");
			const name = entry.slice(0, index).trim();
			const repository = stripTag(entry.slice(index + 1).trim());
			if (
				index <= 0 ||
				!SERVICE_NAME.test(name) ||
				!REPOSITORY.test(repository) ||
				repository.includes("@")
			) {
				throw new Error(
					`Invalid PANARA_CLOUD_IMAGES entry "${entry}" (expected service=repository)`,
				);
			}
			return { name, repository };
		});

export const readPanelConfig = (
	env: NodeJS.ProcessEnv = process.env,
): PanelConfig => {
	const services = parsePanelImages(env.PANARA_CLOUD_IMAGES);
	const releaseTag = env.PANARA_CLOUD_RELEASE_TAG?.trim() || "latest";
	if (!TAG.test(releaseTag)) {
		throw new Error(`Invalid PANARA_CLOUD_RELEASE_TAG "${releaseTag}"`);
	}
	const webService =
		env.PANARA_CLOUD_WEB_SERVICE?.trim() || services[0]?.name || null;
	if (webService && !SERVICE_NAME.test(webService)) {
		throw new Error(`Invalid PANARA_CLOUD_WEB_SERVICE "${webService}"`);
	}
	const panelPort = Number(env.PANARA_CLOUD_PANEL_PORT ?? 3000);
	if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) {
		throw new Error("PANARA_CLOUD_PANEL_PORT must be a port number");
	}
	const migrator = env.PANARA_CLOUD_MIGRATOR?.trim() || null;
	if (migrator && !services.some((service) => service.name === migrator)) {
		throw new Error(
			`PANARA_CLOUD_MIGRATOR "${migrator}" is not one of the PANARA_CLOUD_IMAGES services`,
		);
	}
	const agentService = env.PANARA_CLOUD_AGENT_SERVICE?.trim() || migrator;
	return {
		agentService,
		agentStopGraceSeconds:
			Math.ceil(drainTimeoutMs(env.AGENT_DRAIN_TIMEOUT_SECONDS) / 1000) + 60,
		migrator: migrator
			? {
					service: migrator,
					convexUrl: env.PANARA_CLOUD_CONVEX_SELF_HOSTED_URL?.trim() || null,
					adminKeyFile: env.PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE?.trim() || null,
					inlineAdminKey: Boolean(env.PANARA_CLOUD_CONVEX_ADMIN_KEY?.trim()),
				}
			: null,
		version: env.PANARA_CLOUD_VERSION?.trim() || agentVersion(),
		releaseTag,
		services,
		webService,
		panelPort,
		versionUrl: env.PANARA_CLOUD_VERSION_URL?.trim() || null,
	};
};

const requireServices = (config: PanelConfig) => {
	if (config.services.length === 0) {
		throw new Error(
			"The agent doesn't know the panel services; set PANARA_CLOUD_IMAGES on the agent",
		);
	}
	return config.services;
};

export const parseSemver = (tag: string): [number, number, number] | null => {
	const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export const compareSemver = (a: string, b: string): number => {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
};

export const pickLatestTag = (tags: string[]): string | null =>
	tags
		.filter((tag) => parseSemver(tag))
		.reduce<string | null>(
			(best, tag) => (!best || compareSemver(tag, best) > 0 ? tag : best),
			null,
		);

type Fetch = typeof fetch;

export const parseRepository = (repository: string) => {
	const parts = repository.split("/");
	const first = parts[0] ?? "";
	const hasRegistry =
		parts.length > 1 &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const registry = hasRegistry
		? first === "docker.io"
			? "registry-1.docker.io"
			: first
		: "registry-1.docker.io";
	const rest = hasRegistry ? parts.slice(1).join("/") : repository;
	const name =
		registry === "registry-1.docker.io" && !rest.includes("/")
			? `library/${rest}`
			: rest;
	return { registry, name };
};

const challengeParams = (header: string) =>
	Object.fromEntries(
		[...header.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [
			match[1],
			match[2],
		]),
	) as Record<string, string>;

// Anonymous pull access through the registry's token service (Docker Hub,
// GHCR and most OCI registries answer 401 with a Bearer challenge).
const registryRequest = async (
	fetchFn: Fetch,
	url: string,
	init: RequestInit,
): Promise<Response> => {
	const first = await fetchFn(url, init);
	if (first.status !== 401) return first;
	const challenge = first.headers.get("www-authenticate") ?? "";
	if (!/^bearer /i.test(challenge)) return first;
	const params = challengeParams(challenge);
	if (!params.realm) return first;
	const tokenUrl = new URL(params.realm);
	if (params.service) tokenUrl.searchParams.set("service", params.service);
	if (params.scope) tokenUrl.searchParams.set("scope", params.scope);
	const tokenResponse = await fetchFn(tokenUrl.toString());
	if (!tokenResponse.ok) return first;
	const body = (await tokenResponse.json()) as {
		token?: string;
		access_token?: string;
	};
	const token = body.token ?? body.access_token;
	if (!token) return first;
	return await fetchFn(url, {
		...init,
		headers: { ...(init.headers as object), Authorization: `Bearer ${token}` },
	});
};

const MAX_TAG_PAGES = 10;

export const listRegistryTags = async (
	repository: string,
	fetchFn: Fetch = fetch,
): Promise<string[]> => {
	const { registry, name } = parseRepository(repository);
	const tags: string[] = [];
	let url: string | null = `https://${registry}/v2/${name}/tags/list?n=1000`;
	for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
		const response = await registryRequest(fetchFn, url, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error(`${registry} answered ${response.status} for ${name}`);
		}
		const body = (await response.json()) as { tags?: string[] | null };
		tags.push(...(body.tags ?? []));
		const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
		url = next?.[1] ? new URL(next[1], `https://${registry}`).toString() : null;
	}
	return tags;
};

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
].join(", ");

export const registryDigest = async (
	repository: string,
	tag: string,
	fetchFn: Fetch = fetch,
): Promise<string | null> => {
	const { registry, name } = parseRepository(repository);
	const response = await registryRequest(
		fetchFn,
		`https://${registry}/v2/${name}/manifests/${tag}`,
		{ method: "HEAD", headers: { Accept: MANIFEST_TYPES } },
	);
	if (!response.ok) return null;
	return response.headers.get("docker-content-digest");
};

export const parseVersionFeed = (body: string): string | null => {
	const text = body.trim();
	if (!text) return null;
	try {
		const json = JSON.parse(text) as unknown;
		if (typeof json === "string") return json.trim() || null;
		if (json && typeof json === "object") {
			const record = json as Record<string, unknown>;
			for (const key of ["version", "tag_name", "tag", "name"]) {
				const value = record[key];
				if (typeof value === "string" && value.trim()) return value.trim();
			}
		}
		return null;
	} catch {
		return text.split("\n")[0]?.trim() || null;
	}
};

const statusCode = (error: unknown) =>
	(error as { statusCode?: number })?.statusCode;

type Resource =
	| { kind: "service"; image: string; spec: Dockerode.ServiceSpec }
	| { kind: "container"; image: string; info: Dockerode.ContainerInspectInfo }
	| { kind: "missing" };

const inspectResource = async (
	docker: Dockerode,
	name: string,
): Promise<Resource> => {
	try {
		const service = await docker.getService(name).inspect();
		const spec = service.Spec as Dockerode.ServiceSpec;
		return {
			kind: "service",
			image:
				(
					spec.TaskTemplate as
						| { ContainerSpec?: { Image?: string } }
						| undefined
				)?.ContainerSpec?.Image ?? "",
			spec,
		};
	} catch (error) {
		// 503: the daemon isn't a Swarm manager, so only containers exist.
		if (statusCode(error) !== 404 && statusCode(error) !== 503) throw error;
	}
	try {
		const info = await docker.getContainer(name).inspect();
		return { kind: "container", image: info.Config.Image, info };
	} catch (error) {
		if (statusCode(error) !== 404) throw error;
		return { kind: "missing" };
	}
};

const isRunning = async (
	docker: Dockerode,
	name: string,
	resource: Resource,
) => {
	if (resource.kind === "container") return resource.info.State.Running;
	if (resource.kind === "missing") return false;
	const tasks = await docker.listTasks({
		filters: JSON.stringify({ service: [name], "desired-state": ["running"] }),
	});
	return tasks.some((task) => task.Status?.State === "running");
};

const publishesPort = (resource: Resource, port: number): boolean | null => {
	if (resource.kind === "service") {
		return (resource.spec.EndpointSpec?.Ports ?? []).some(
			(entry) => entry.TargetPort === port,
		);
	}
	if (resource.kind === "container") {
		const bindings = resource.info.HostConfig.PortBindings ?? {};
		return Boolean(
			(bindings as Record<string, unknown[] | null>)[`${port}/tcp`]?.length,
		);
	}
	return null;
};

export const recoveryCommand = (config: PanelConfig) =>
	`docker service update --publish-add published=${config.panelPort},target=${config.panelPort},mode=host ${config.webService ?? "<panel-service>"}`;

// The "panel" snapshot: what the Web Server screen shows (version, the
// services and whether port 3000 is published).
export const readPanelStatus = async (host: Host, config: PanelConfig) => {
	const docker = host.docker();
	const services = await Promise.all(
		config.services.map(async (service) => {
			const resource = await inspectResource(docker, service.name);
			return {
				...service,
				kind: resource.kind,
				image: resource.kind === "missing" ? null : resource.image,
				running: await isRunning(docker, service.name, resource),
			};
		}),
	);
	const web = config.webService
		? await inspectResource(docker, config.webService)
		: ({ kind: "missing" } as const);
	return {
		version: config.version,
		releaseTag: config.releaseTag,
		panelPort: config.panelPort,
		webService: config.webService,
		webServiceKind: web.kind,
		panelPortPublished: publishesPort(web, config.panelPort),
		recoveryCommand: recoveryCommand(config),
		services,
	};
};

export type UpdateData = {
	currentVersion: string;
	releaseTag: string;
	latestVersion: string | null;
	updateAvailable: boolean;
};

const digestOf = (image: string) => image.split("@")[1] ?? null;

// Update check: stable installs compare versions; moving channels
// ("canary") compare the running image digest with the registry's.
export const checkForUpdate = async (
	host: Host,
	config: PanelConfig,
	fetchFn: Fetch = fetch,
): Promise<UpdateData> => {
	const [primary] = requireServices(config);
	if (!primary) throw new Error("No panel services configured");
	if (config.releaseTag !== "latest") {
		const resource = await inspectResource(host.docker(), primary.name);
		const current =
			resource.kind === "missing" ? null : digestOf(resource.image);
		const latest = await registryDigest(
			primary.repository,
			config.releaseTag,
			fetchFn,
		);
		return {
			currentVersion: config.version,
			releaseTag: config.releaseTag,
			latestVersion: config.releaseTag,
			updateAvailable: !!latest && !!current && latest !== current,
		};
	}
	let latest: string | null;
	if (config.versionUrl) {
		const response = await fetchFn(config.versionUrl, {
			headers: { Accept: "application/json, text/plain" },
		});
		if (!response.ok) {
			throw new Error(`Version source answered ${response.status}`);
		}
		latest = parseVersionFeed(await response.text());
	} else {
		latest = pickLatestTag(await listRegistryTags(primary.repository, fetchFn));
	}
	if (latest && !TAG.test(latest)) {
		throw new Error(`Unexpected version "${latest}" from the version source`);
	}
	return {
		currentVersion: config.version,
		releaseTag: config.releaseTag,
		latestVersion: latest,
		updateAvailable: !!latest && compareSemver(latest, config.version) > 0,
	};
};

// Reloads the panel. Swarm services roll their tasks; plain containers
// restart a few seconds later in the background so this job can still
// report back when the agent's own container is among them.
export const reloadPanel = async (
	host: Host,
	config: PanelConfig,
	log: (line: string) => void,
) => {
	const docker = host.docker();
	const containers: string[] = [];
	for (const service of requireServices(config)) {
		const resource = await inspectResource(docker, service.name);
		if (resource.kind === "service") {
			log(`Restarting service ${service.name}`);
			await runScript(
				host,
				`$DOCKER service update --detach --force ${quote(service.name)}`,
			);
		} else if (resource.kind === "container") {
			containers.push(service.name);
		} else {
			log(`${service.name} not found, skipping`);
		}
	}
	if (containers.length > 0) {
		log(`Restarting containers ${containers.join(", ")}`);
		await runScript(
			host,
			`nohup bash -c "sleep 3; $DOCKER restart ${containers.join(" ")}" >/dev/null 2>&1 &`,
		);
	}
};

// The new version's functions must be live before its web and agent
// services start, so the migration runs from the new image as a one-off
// container on the panel network. The admin key reaches it as a read-only
// file mount (or inherited env), never as an argument.
export const migrateScript = (
	migrator: NonNullable<PanelConfig["migrator"]>,
	image: string,
) => {
	if (!migrator.adminKeyFile && !migrator.inlineAdminKey) {
		throw new Error(
			"PANARA_CLOUD_MIGRATOR needs PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE or PANARA_CLOUD_CONVEX_ADMIN_KEY on the agent",
		);
	}
	const args = [
		"run --rm",
		`--network ${quote(NETWORK_NAME)}`,
		...(migrator.convexUrl
			? [`-e CONVEX_SELF_HOSTED_URL=${quote(migrator.convexUrl)}`]
			: []),
		...(migrator.adminKeyFile
			? [
					`-v ${quote(`${migrator.adminKeyFile}:/run/panara-cloud/convex-admin-key:ro`)}`,
					"-e CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=/run/panara-cloud/convex-admin-key",
				]
			: ["-e CONVEX_SELF_HOSTED_ADMIN_KEY"]),
		quote(image),
		"migrate",
	];
	const run = `$DOCKER ${args.join(" ")}`;
	return migrator.adminKeyFile
		? run
		: `CONVEX_SELF_HOSTED_ADMIN_KEY="$PANARA_CLOUD_CONVEX_ADMIN_KEY" ${run}`;
};

// Updates the panel: pulls every image at the new tag, then points the
// Swarm services at it (the agent's own service last, as listed).
export const updatePanel = async (
	host: Host,
	config: PanelConfig,
	log: (line: string) => void,
	fetchFn: Fetch = fetch,
): Promise<UpdateData> => {
	const services = requireServices(config);
	const data = await checkForUpdate(host, config, fetchFn);
	if (!data.updateAvailable || !data.latestVersion) {
		log("Panara Cloud is already up to date");
		return data;
	}
	const docker = host.docker();
	for (const service of services) {
		const resource = await inspectResource(docker, service.name);
		if (resource.kind !== "service") {
			throw new Error(
				`${service.name} is not running as a Docker Swarm service, so in-panel updates are unavailable; update it manually instead`,
			);
		}
	}
	const tag = data.latestVersion;
	// Everything after the pull runs by the digest the registry served: any
	// build on this daemon (a member's compose `build:` with `image:` set to
	// this repository) can overwrite the local tag meanwhile, and the
	// migrator receives the Convex admin key.
	const pinned = new Map<string, string>();
	for (const service of services) {
		const image = `${service.repository}:${tag}`;
		log(`Pulling ${image}`);
		const output = await runScript(host, `$DOCKER pull ${quote(image)}`, {
			onOutput: () => {},
		});
		const digest = output.match(/Digest: (sha256:[0-9a-f]{64})/)?.[1];
		if (!digest) {
			throw new Error(
				`Pulling ${image} did not report a digest, so the update can't pin it`,
			);
		}
		pinned.set(service.name, `${image}@${digest}`);
	}
	if (config.migrator) {
		const image = pinned.get(config.migrator.service);
		if (!image) {
			throw new Error(
				`PANARA_CLOUD_MIGRATOR ${config.migrator.service} is not one of the panel services`,
			);
		}
		log(`Deploying Convex functions and running migrations with ${image}`);
		await runScript(host, migrateScript(config.migrator, image), {
			onOutput: (text) => {
				for (const line of text.split("\n")) if (line.trim()) log(line);
			},
		});
	} else {
		log(
			"⚠️ PANARA_CLOUD_MIGRATOR is not set: Convex functions were not deployed; run the installer's upgrade instead",
		);
	}
	for (const service of services) {
		const image = pinned.get(service.name) ?? "";
		log(`Updating ${service.name} to ${image}`);
		// Installs from before the agent drained on shutdown have a 40 s grace
		// period, which would kill the jobs running at that moment.
		const grace =
			service.name === config.agentService
				? ` --stop-grace-period ${config.agentStopGraceSeconds}s`
				: "";
		await runScript(
			host,
			`$DOCKER service update --detach --with-registry-auth${grace} --image ${quote(image)} ${quote(service.name)}`,
		);
	}
	return data;
};

// Publishes or unpublishes the panel's port on its Swarm service.
export const setPanelPort = async (
	host: Host,
	config: PanelConfig,
	enabled: boolean,
) => {
	if (!config.webService) {
		throw new Error(
			"The agent doesn't know the panel service; set PANARA_CLOUD_IMAGES or PANARA_CLOUD_WEB_SERVICE",
		);
	}
	const resource = await inspectResource(host.docker(), config.webService);
	if (resource.kind !== "service") {
		throw new Error(
			"The Panara Cloud panel is not running as a Docker Swarm service, the port can't be managed from the UI",
		);
	}
	const port = config.panelPort;
	const flags = enabled
		? `--publish-add published=${port},target=${port},mode=host`
		: `--publish-rm published=${port},target=${port},mode=host --publish-rm published=${port},target=${port},mode=ingress`;
	await runScript(
		host,
		`$DOCKER service update --detach ${flags} ${quote(config.webService)}`,
	);
};

const PUBLIC_IP_SOURCES = [
	"https://ifconfig.io",
	"https://api.ipify.org",
	"https://icanhazip.com",
];

// Public IP lookup (IPv4 first, then IPv6, across several services), run on
// the host itself so it reports the host's address rather than the agent's.
export const detectPublicIp = async (host: Host): Promise<string | null> => {
	for (const family of ["-4", "-6"]) {
		for (const url of PUBLIC_IP_SOURCES) {
			const result = await host.exec(
				`curl ${family} -fsS --max-time 5 ${quote(url)}`,
			);
			const ip = result.output.trim();
			if (result.code === 0 && isIP(ip)) return ip;
		}
	}
	return null;
};
