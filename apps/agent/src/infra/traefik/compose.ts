import { NETWORK_NAME } from "../../lib/constants";
import type { RoutingDomain } from "./routing";

// Loose compose spec shape: only what routing touches.
export type ComposeLabels = string[] | Record<string, string>;
export type ComposeNetworks = string[] | Record<string, unknown>;
export type ComposeService = {
	labels?: ComposeLabels;
	networks?: ComposeNetworks;
	network_mode?: string;
	deploy?: { labels?: ComposeLabels; [key: string]: unknown };
	[key: string]: unknown;
};
export type ComposeSpec = {
	services?: Record<string, ComposeService>;
	networks?: Record<string, unknown>;
	[key: string]: unknown;
};

export type ComposeRoutingInput = {
	appName: string;
	composeType: "docker-compose" | "stack";
	domains: RoutingDomain[];
	// Isolated deployments route over their own network instead of
	// panara-cloud-network.
	isolatedNetwork?: string;
};

// Traefik router, service and middleware labels for one domain of a compose
// service.
export const createDomainLabels = (
	appName: string,
	domain: RoutingDomain,
	entrypoint: string,
): string[] => {
	const routerName = `${appName}-${domain.id}-${entrypoint}`;
	const { path, https, customEntrypoint } = domain;
	const labels = [
		`traefik.http.routers.${routerName}.rule=Host(\`${domain.host}\`)${path && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		`traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
		`traefik.http.services.${routerName}.loadbalancer.server.port=${domain.port}`,
		`traefik.http.routers.${routerName}.service=${routerName}`,
	];
	const middlewares: string[] = [];
	const isRedirectRouter = entrypoint === "web" && https && !customEntrypoint;
	// Middlewares are declared once, on the web (or custom) router's labels.
	const declares = entrypoint === "web" || Boolean(customEntrypoint);
	if (isRedirectRouter) middlewares.push("redirect-to-https@file");
	if (domain.stripPath && path && path !== "/") {
		const name = `stripprefix-${appName}-${domain.id}`;
		if (declares) {
			labels.push(
				`traefik.http.middlewares.${name}.stripprefix.prefixes=${path}`,
			);
		}
		if (!isRedirectRouter) middlewares.push(name);
	}
	if (domain.internalPath && domain.internalPath !== "/") {
		const name = `addprefix-${appName}-${domain.id}`;
		if (declares) {
			labels.push(
				`traefik.http.middlewares.${name}.addprefix.prefix=${domain.internalPath}`,
			);
		}
		if (!isRedirectRouter) middlewares.push(name);
	}
	if (!isRedirectRouter) middlewares.push(...domain.middlewares);
	if (middlewares.length > 0) {
		labels.push(
			`traefik.http.routers.${routerName}.middlewares=${middlewares.join(",")}`,
		);
	}
	if (entrypoint === "websecure" || (customEntrypoint && https)) {
		if (domain.certificateType === "letsencrypt") {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`,
			);
		} else if (
			domain.certificateType === "custom" &&
			domain.customCertResolver
		) {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=${domain.customCertResolver}`,
			);
		} else if (domain.certificateType === "none" && https) {
			labels.push(`traefik.http.routers.${routerName}.tls=true`);
		}
	}
	return labels;
};

const removeDomainLabels = (
	labels: ComposeLabels | undefined,
	appName: string,
	domainId: string,
): ComposeLabels | undefined => {
	const prefixes = [
		`traefik.http.routers.${appName}-${domainId}-`,
		`traefik.http.services.${appName}-${domainId}-`,
		`traefik.http.middlewares.stripprefix-${appName}-${domainId}.`,
		`traefik.http.middlewares.addprefix-${appName}-${domainId}.`,
	];
	const owned = (label: string) => prefixes.some((p) => label.startsWith(p));
	if (Array.isArray(labels)) return labels.filter((label) => !owned(label));
	if (labels) {
		return Object.fromEntries(
			Object.entries(labels).filter(([label]) => !owned(label)),
		);
	}
	return labels;
};

export const addNetworkToService = (
	networks: ComposeNetworks | undefined,
	networkName = NETWORK_NAME,
): ComposeNetworks => {
	const result = networks ?? [];
	if (Array.isArray(result)) {
		for (const name of [networkName, "default"]) {
			if (!result.includes(name)) result.push(name);
		}
	} else {
		for (const name of [networkName, "default"]) {
			if (!(name in result)) result[name] = {};
		}
	}
	return result;
};

export const addExternalNetworkToRoot = (
	networks: Record<string, unknown> | undefined,
	networkName = NETWORK_NAME,
): Record<string, unknown> => ({
	...(networks ?? {}),
	[networkName]: { external: true },
});

const usesNetwork = (spec: ComposeSpec, name: string) =>
	Object.values(spec.services ?? {}).some((service) => {
		const nets = service?.networks;
		if (Array.isArray(nets)) return nets.includes(name);
		return Boolean(nets && typeof nets === "object" && name in nets);
	});

// Works on an already parsed spec: adds Traefik labels
// for each domain to its service (deploy.labels for stacks), joins routed
// services to panara-cloud-network and declares it external. Mutates and returns
// `spec`. Throws when a domain names a missing service.
export const addDomainsToCompose = (
	spec: ComposeSpec,
	input: ComposeRoutingInput,
): ComposeSpec => {
	const { appName, composeType } = input;
	const isStack = composeType === "stack";
	for (const domain of input.domains) {
		for (const service of Object.values(spec.services ?? {})) {
			if (!isStack) {
				service.labels = removeDomainLabels(service.labels, appName, domain.id);
			} else if (service.deploy) {
				service.deploy.labels = removeDomainLabels(
					service.deploy.labels,
					appName,
					domain.id,
				);
			}
		}
	}
	const networkName = input.isolatedNetwork ?? NETWORK_NAME;
	for (const domain of input.domains) {
		const service = domain.serviceName
			? spec.services?.[domain.serviceName]
			: undefined;
		if (!domain.enabled) {
			if (service && !service.network_mode && !input.isolatedNetwork) {
				service.networks = addNetworkToService(service.networks);
			}
			continue;
		}
		if (!domain.serviceName) {
			throw new Error(`Domain "${domain.host}" is missing a service name`);
		}
		if (!service) {
			throw new Error(
				`Domain "${domain.host}" is attached to service "${domain.serviceName}" which does not exist in the compose`,
			);
		}
		const httpLabels = createDomainLabels(
			appName,
			domain,
			domain.customEntrypoint || "web",
		);
		if (!domain.customEntrypoint && domain.https) {
			httpLabels.push(...createDomainLabels(appName, domain, "websecure"));
		}
		let labels: ComposeLabels;
		if (isStack) {
			service.deploy ??= {};
			service.deploy.labels ??= [];
			labels = service.deploy.labels;
		} else {
			service.labels ??= [];
			labels = service.labels;
		}
		const networkLabel = isStack
			? "traefik.swarm.network"
			: "traefik.docker.network";
		if (Array.isArray(labels)) {
			if (!labels.includes("traefik.enable=true"))
				labels.unshift("traefik.enable=true");
			labels.unshift(...httpLabels);
			const entry = `${networkLabel}=${networkName}`;
			if (!labels.includes(entry)) labels.unshift(entry);
		} else {
			labels["traefik.enable"] = "true";
			labels[networkLabel] = networkName;
			for (const label of httpLabels) {
				const index = label.indexOf("=");
				labels[label.slice(0, index)] = label.slice(index + 1);
			}
		}
		if (!input.isolatedNetwork) {
			service.networks = addNetworkToService(service.networks);
		}
	}
	if (!input.isolatedNetwork && usesNetwork(spec, NETWORK_NAME)) {
		spec.networks = addExternalNetworkToRoot(spec.networks);
	}
	return spec;
};
