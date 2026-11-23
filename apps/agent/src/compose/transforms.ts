import { parse, stringify } from "yaml";
import {
	addDomainsToCompose,
	addExternalNetworkToRoot,
	addNetworkToService,
	type ComposeSpec,
	type RoutingDomain,
} from "../infra/traefik";
import { NETWORK_NAME } from "../lib/constants";
import { panaraCloudLabels } from "../lib/swarm";

export type { ComposeSpec };
export type ComposeService = NonNullable<ComposeSpec["services"]>[string];
type Labels = ComposeService["labels"];

export type ComposeType = "docker-compose" | "stack";

export type ServiceNetworkConfig = {
	serviceName: string;
	// Docker network names.
	networks: string[];
	detachPanaraCloudNetwork: boolean;
};

export type ResolveInput = {
	composeId: string;
	name: string;
	appName: string;
	composeType: ComposeType;
	organizationId: string;
	projectId: string;
	environmentId: string;
	randomize: boolean;
	suffix: string;
	isolatedDeployment: boolean;
	isolatedDeploymentsVolume: boolean;
	domains: RoutingDomain[];
	serviceNetworks: ServiceNetworkConfig[];
};

export const parseCompose = (text: string): ComposeSpec => {
	const spec = parse(text, { maxAliasCount: 10000, merge: true }) as unknown;
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		throw new Error("The compose file is empty or not a YAML mapping");
	}
	return spec as ComposeSpec;
};

export const stringifyCompose = (spec: ComposeSpec): string =>
	stringify(spec, { lineWidth: 1000 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const renameKeys = <T>(
	record: Record<string, T>,
	rename: (key: string) => string,
): Record<string, T> =>
	Object.fromEntries(
		Object.entries(record).map(([key, value]) => [rename(key), value]),
	);

const mapServices = (
	spec: ComposeSpec,
	fn: (service: ComposeService, name: string) => void,
) => {
	for (const [name, service] of Object.entries(spec.services ?? {})) {
		if (service) fn(service, name);
	}
};

// Suffixes service names and the references to them (depends_on,
// container_name, links, extends, volumes_from, `network_mode: service:x`),
// so no reference is left dangling.
export const addSuffixToServiceNames = (
	spec: ComposeSpec,
	suffix: string,
): ComposeSpec => {
	if (!spec.services) return spec;
	const withSuffix = (name: string) => `${name}-${suffix}`;
	mapServices(spec, (service) => {
		const dependsOn = service.depends_on;
		if (Array.isArray(dependsOn)) {
			service.depends_on = dependsOn.map((dep) => withSuffix(String(dep)));
		} else if (isRecord(dependsOn)) {
			service.depends_on = renameKeys(dependsOn, withSuffix);
		}
		if (typeof service.container_name === "string") {
			service.container_name = withSuffix(service.container_name);
		}
		if (Array.isArray(service.links)) {
			service.links = service.links.map((link) => {
				const [target, alias] = String(link).split(":");
				return alias
					? `${withSuffix(target ?? "")}:${alias}`
					: withSuffix(String(link));
			});
		}
		if (typeof service.extends === "string") {
			service.extends = withSuffix(service.extends);
		} else if (
			isRecord(service.extends) &&
			typeof service.extends.service === "string"
		) {
			service.extends = {
				...service.extends,
				service: withSuffix(service.extends.service),
			};
		}
		if (Array.isArray(service.volumes_from)) {
			service.volumes_from = service.volumes_from.map((entry) => {
				const value = String(entry);
				if (value.startsWith("container:")) return value;
				const [target, ...mode] = value.split(":");
				return [withSuffix(target ?? ""), ...mode].join(":");
			});
		}
		if (
			typeof service.network_mode === "string" &&
			service.network_mode.startsWith("service:")
		) {
			service.network_mode = `service:${withSuffix(service.network_mode.slice(8))}`;
		}
	});
	spec.services = renameKeys(spec.services, withSuffix);
	return spec;
};

// Named volumes only: bind mounts (./, /, ~) and variables are left alone.
const suffixVolumeEntry = (volume: unknown, suffix: string): unknown => {
	if (typeof volume === "string") {
		const [source, ...rest] = volume.split(":");
		const remainder = rest.join(":");
		if (!source || !remainder || /^[./~$]/.test(source)) return volume;
		const [base, ...sub] = source.split("/");
		return sub.length > 0
			? `${base}-${suffix}/${sub.join("/")}:${remainder}`
			: `${source}-${suffix}:${remainder}`;
	}
	if (
		isRecord(volume) &&
		volume.type === "volume" &&
		typeof volume.source === "string" &&
		volume.source
	) {
		return { ...volume, source: `${volume.source}-${suffix}` };
	}
	return volume;
};

export const addSuffixToAllVolumes = (
	spec: ComposeSpec,
	suffix: string,
): ComposeSpec => {
	if (isRecord(spec.volumes)) {
		spec.volumes = renameKeys(spec.volumes, (key) => `${key}-${suffix}`);
	}
	mapServices(spec, (service) => {
		if (Array.isArray(service.volumes)) {
			service.volumes = service.volumes.map((volume) =>
				suffixVolumeEntry(volume, suffix),
			);
		}
	});
	return spec;
};

export const addSuffixToAllNetworks = (
	spec: ComposeSpec,
	suffix: string,
): ComposeSpec => {
	const rename = (key: string) =>
		key === NETWORK_NAME || key === "default" ? key : `${key}-${suffix}`;
	if (isRecord(spec.networks)) {
		spec.networks = renameKeys(spec.networks, rename);
	}
	mapServices(spec, (service) => {
		if (Array.isArray(service.networks)) {
			service.networks = service.networks.map((name) => rename(String(name)));
		} else if (isRecord(service.networks)) {
			service.networks = renameKeys(service.networks, rename);
		}
	});
	return spec;
};

const suffixReferences = (
	spec: ComposeSpec,
	key: "configs" | "secrets",
	suffix: string,
): ComposeSpec => {
	const root = spec[key];
	if (isRecord(root)) {
		spec[key] = renameKeys(root, (name) => `${name}-${suffix}`);
	}
	mapServices(spec, (service) => {
		const refs = service[key];
		if (!Array.isArray(refs)) return;
		service[key] = refs.map((ref) => {
			if (typeof ref === "string") return `${ref}-${suffix}`;
			if (isRecord(ref) && typeof ref.source === "string") {
				return { ...ref, source: `${ref.source}-${suffix}` };
			}
			return ref;
		});
	});
	return spec;
};

// Randomizes a compose file: suffixes services, volumes, networks, configs and
// secrets so two copies of a compose file can share a host.
export const addSuffixToAllProperties = (
	spec: ComposeSpec,
	suffix: string,
): ComposeSpec => {
	addSuffixToServiceNames(spec, suffix);
	addSuffixToAllVolumes(spec, suffix);
	addSuffixToAllNetworks(spec, suffix);
	suffixReferences(spec, "configs", suffix);
	suffixReferences(spec, "secrets", suffix);
	return spec;
};

// Isolated deployment: every service joins an external network
// named after the app (created by the deploy), so services of different
// compose projects cannot reach each other over panara-cloud-network.
export const addIsolatedNetwork = (
	spec: ComposeSpec,
	appName: string,
	suffixVolumes: boolean,
): ComposeSpec => {
	spec.networks = {
		...(isRecord(spec.networks) ? spec.networks : {}),
		[appName]: { name: appName, external: true },
	};
	mapServices(spec, (service) => {
		if (service.network_mode) return;
		if (!service.networks) {
			service.networks = [appName];
		} else if (Array.isArray(service.networks)) {
			if (!service.networks.includes(appName)) service.networks.push(appName);
		} else {
			service.networks[appName] = {};
		}
	});
	if (suffixVolumes) addSuffixToAllVolumes(spec, appName);
	return spec;
};

const mergeLabels = (
	current: Labels,
	labels: Record<string, string>,
): Labels => {
	if (current && !Array.isArray(current)) return { ...current, ...labels };
	const keys = new Set(Object.keys(labels));
	const kept = (current ?? []).filter(
		(label) => !keys.has(label.slice(0, label.indexOf("="))),
	);
	return [...kept, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)];
};

export const applyPanaraCloudLabels = (
	spec: ComposeSpec,
	input: Pick<
		ResolveInput,
		| "composeId"
		| "name"
		| "composeType"
		| "organizationId"
		| "projectId"
		| "environmentId"
	>,
): ComposeSpec => {
	mapServices(spec, (service, serviceName) => {
		const labels = {
			...panaraCloudLabels({
				organizationId: input.organizationId,
				projectId: input.projectId,
				environmentId: input.environmentId,
				serviceKind: "compose",
				serviceId: input.composeId,
				serviceName: input.name,
			}),
			"panara-cloud.compose.service": serviceName,
		};
		// docker compose interpolates `$`; user-typed names must stay literal.
		const escaped = Object.fromEntries(
			Object.entries(labels).map(([k, v]) => [k, v.replaceAll("$", "$$$$")]),
		);
		service.labels = mergeLabels(service.labels, escaped);
		if (input.composeType === "stack") {
			service.deploy ??= {};
			service.deploy.labels = mergeLabels(service.deploy.labels, escaped);
		}
	});
	return spec;
};

const usesNetwork = (spec: ComposeSpec, name: string) =>
	Object.values(spec.services ?? {}).some((service) => {
		const nets = service?.networks;
		if (Array.isArray(nets)) return nets.includes(name);
		return isRecord(nets) && name in nets;
	});

const removeNetwork = (service: ComposeService, name: string) => {
	if (Array.isArray(service.networks)) {
		service.networks = service.networks.filter((n) => n !== name);
	} else if (isRecord(service.networks)) {
		delete service.networks[name];
	}
};

const stripPanaraCloudNetworkLabel = (labels: Labels): Labels =>
	Array.isArray(labels)
		? labels.filter(
				(label) =>
					label !== `traefik.docker.network=${NETWORK_NAME}` &&
					label !== `traefik.swarm.network=${NETWORK_NAME}`,
			)
		: labels;

// Joins services to their extra networks (optionally detaching them from
// panara-cloud-network) and declares the networks in use at the top level.
export const applyServiceNetworks = (
	spec: ComposeSpec,
	configs: ServiceNetworkConfig[],
	isolated: boolean,
): ComposeSpec => {
	const injected = new Set<string>();
	for (const config of configs) {
		const service = spec.services?.[config.serviceName];
		if (!service) continue;
		for (const name of config.networks) {
			service.networks = addNetworkToService(service.networks, name);
			injected.add(name);
		}
		if (config.detachPanaraCloudNetwork) {
			removeNetwork(service, NETWORK_NAME);
			removeNetwork(service, "default");
			service.labels = stripPanaraCloudNetworkLabel(service.labels);
			if (service.deploy?.labels) {
				service.deploy.labels = stripPanaraCloudNetworkLabel(
					service.deploy.labels,
				);
			}
		}
	}
	if (!isolated) {
		const networks = isRecord(spec.networks) ? { ...spec.networks } : {};
		if (!usesNetwork(spec, NETWORK_NAME)) delete networks[NETWORK_NAME];
		spec.networks = networks;
		if (usesNetwork(spec, NETWORK_NAME)) {
			spec.networks = addExternalNetworkToRoot(spec.networks);
		}
		for (const name of injected) {
			if (usesNetwork(spec, name)) {
				spec.networks = addExternalNetworkToRoot(spec.networks, name);
			}
		}
		if (Object.keys(spec.networks).length === 0) delete spec.networks;
	}
	return spec;
};

// Collision handling as the next deploy applies it: isolated deployments
// get their own network, otherwise `randomize` suffixes every name.
export const applyCollisionTransforms = (
	spec: ComposeSpec,
	input: Pick<
		ResolveInput,
		| "appName"
		| "randomize"
		| "suffix"
		| "isolatedDeployment"
		| "isolatedDeploymentsVolume"
	>,
): ComposeSpec => {
	if (input.isolatedDeployment) {
		return addIsolatedNetwork(
			spec,
			input.appName,
			input.isolatedDeploymentsVolume,
		);
	}
	if (input.randomize && input.suffix) {
		return addSuffixToAllProperties(spec, input.suffix);
	}
	return spec;
};

// Services one-shot by design: others wait for them to exit successfully.
const completionDependencies = (spec: ComposeSpec): Set<string> => {
	const names = new Set<string>();
	for (const service of Object.values(spec.services ?? {})) {
		const dependsOn = service?.depends_on;
		if (!isRecord(dependsOn)) continue;
		for (const [name, options] of Object.entries(dependsOn)) {
			if (
				isRecord(options) &&
				options.condition === "service_completed_successfully"
			) {
				names.add(name);
			}
		}
	}
	return names;
};

// Docker's default `restart: "no"` leaves a service down after a reboot or a
// Docker restart, which users don't expect from a deployed app. Swarm stacks
// restart by default (deploy.restart_policy) and are left alone, as are
// services that set a policy of their own and one-shot jobs, which would
// otherwise run in a loop.
export const applyDefaultRestartPolicy = (
	spec: ComposeSpec,
	composeType: ComposeType,
): ComposeSpec => {
	if (composeType !== "docker-compose") return spec;
	const oneShot = completionDependencies(spec);
	mapServices(spec, (service, serviceName) => {
		if (service.restart !== undefined) return;
		if (isRecord(service.deploy) && service.deploy.restart_policy !== undefined)
			return;
		if (oneShot.has(serviceName)) return;
		service.restart = "unless-stopped";
	});
	return spec;
};

// Resolves the compose file to deploy: collision transforms, Traefik labels for
// the domains, Panara Cloud labels and extra service networks. Returns a new spec.
export const resolveComposeSpec = (
	source: ComposeSpec,
	input: ResolveInput,
): ComposeSpec => {
	const spec = applyCollisionTransforms(structuredClone(source), input);
	addDomainsToCompose(spec, {
		appName: input.appName,
		composeType: input.composeType,
		domains: input.domains,
		isolatedNetwork: input.isolatedDeployment ? input.appName : undefined,
	});
	applyPanaraCloudLabels(spec, input);
	applyDefaultRestartPolicy(spec, input.composeType);
	applyServiceNetworks(spec, input.serviceNetworks, input.isolatedDeployment);
	return spec;
};

// Service names as the domain picker must reference them (after
// randomization; isolated deployments keep their names).
export const listServices = (
	source: ComposeSpec,
	input: Pick<
		ResolveInput,
		| "appName"
		| "randomize"
		| "suffix"
		| "isolatedDeployment"
		| "isolatedDeploymentsVolume"
	>,
): string[] =>
	Object.keys(
		applyCollisionTransforms(structuredClone(source), input).services ?? {},
	);
