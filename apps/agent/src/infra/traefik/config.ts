import { parse, stringify } from "yaml";
import type { Host } from "../../host/types";
import { NETWORK_NAME, paths } from "../../lib/constants";
import { removeHostPath } from "../shell";
import type {
	CertificateType,
	FileConfig,
	HttpMiddleware,
	HttpRouter,
	HttpService,
	MainTraefikConfig,
} from "./types";

export const TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || "3.7.19";
export const TRAEFIK_IMAGE = `traefik:v${TRAEFIK_VERSION}`;
export const TRAEFIK_PORT = Number(process.env.TRAEFIK_PORT) || 80;
export const TRAEFIK_SSL_PORT = Number(process.env.TRAEFIK_SSL_PORT) || 443;
export const TRAEFIK_HTTP3_PORT = Number(process.env.TRAEFIK_HTTP3_PORT) || 443;
export const TRAEFIK_DASHBOARD_PORT = 8080;

// Traefik sees the dynamic directory at the same path as the host, so the
// certificate paths written into YAML resolve on both sides.
export const CONTAINER_DYNAMIC_PATH = paths.traefikDynamic;
export const MAIN_CONFIG_PATH = `${paths.traefik}/traefik.yml`;
export const MIDDLEWARES_PATH = `${paths.traefikDynamic}/middlewares.yml`;
export const PANEL_CONFIG_PATH = `${paths.traefikDynamic}/panara-cloud.yml`;
export const ACME_PATH = `${paths.traefikDynamic}/acme.json`;

// Where Traefik reaches the panel UI on panara-cloud-network.
export const PANEL_SERVICE_URL =
	process.env.PANARA_CLOUD_PANEL_URL || "http://panara-cloud-web:3000";

// On a panel domain, browsers reach Convex and the agent's live endpoint on
// the panel's own origin (one certificate, no mixed content). The production
// stack sets these upstreams; without them only the UI is routed.
export type PanelPathRoute = {
	name: string;
	prefix: string;
	url: string;
	stripPrefix: boolean;
};

export const panelPathRoutes = (
	env: NodeJS.ProcessEnv = process.env,
): PanelPathRoute[] =>
	[
		{
			name: "convex",
			prefix: "/convex",
			url: env.PANARA_CLOUD_CONVEX_UPSTREAM,
			stripPrefix: true,
		},
		// Convex's Node action runtime calls back to
		// `new URL("/api/actions/...", CONVEX_CLOUD_ORIGIN)`, which drops the
		// `/convex` prefix; without this route those callbacks reach the web
		// app and every "use node" action that runs a query or mutation fails.
		{
			name: "convex-actions",
			prefix: "/api/actions",
			url: env.PANARA_CLOUD_CONVEX_UPSTREAM,
			stripPrefix: false,
		},
		{
			name: "convex-site",
			prefix: "/convex-site",
			url: env.PANARA_CLOUD_CONVEX_SITE_UPSTREAM,
			stripPrefix: true,
		},
		{
			name: "live",
			prefix: "/live",
			url: env.PANARA_CLOUD_LIVE_UPSTREAM,
			stripPrefix: false,
		},
	].flatMap((route) =>
		route.url?.trim() ? [{ ...route, url: route.url.trim() }] : [],
	);

// The insecure API (port 8080) is unauthenticated and reachable from every
// container on the Panara Cloud network, so it is only served while the
// dashboard is enabled; the published port is then bound to the host's
// loopback (see container.ts), reachable through an SSH tunnel.
const apiConfig = (dashboard: boolean): MainTraefikConfig["api"] =>
	dashboard ? { insecure: true, dashboard: true } : { dashboard: true };

// Swarm workers can't use the swarm provider, so it's left out there.
export const mainTraefikConfig = (
	withSwarmProvider: boolean,
	dashboard = false,
): MainTraefikConfig => ({
	providers: {
		...(withSwarmProvider && {
			swarm: { exposedByDefault: false, watch: true },
		}),
		docker: { exposedByDefault: false, watch: true, network: NETWORK_NAME },
		file: { directory: CONTAINER_DYNAMIC_PATH, watch: true },
	},
	entryPoints: {
		web: { address: `:${TRAEFIK_PORT}` },
		websecure: {
			address: `:${TRAEFIK_SSL_PORT}`,
			http3: { advertisedPort: TRAEFIK_HTTP3_PORT },
			http: { tls: { certResolver: "letsencrypt" } },
		},
	},
	api: apiConfig(dashboard),
	certificatesResolvers: {
		letsencrypt: {
			acme: {
				email: "test@localhost.com",
				storage: ACME_PATH,
				httpChallenge: { entryPoint: "web" },
			},
		},
	},
});

export const defaultMiddlewares = (): FileConfig => ({
	http: {
		middlewares: {
			"redirect-to-https": {
				redirectScheme: { scheme: "https", permanent: true },
			},
		},
	},
});

export const toYaml = (value: unknown): string =>
	stringify(value, { lineWidth: 0 });

export const readYaml = async <T>(
	host: Host,
	path: string,
): Promise<T | null> => {
	const content = await host.readFile(path);
	if (content === null || !content.trim()) return null;
	return (parse(content) as T) ?? null;
};

// Writes the main config and default middlewares when missing; on a Swarm
// worker it also strips the swarm provider from an existing config.
export const ensureTraefikConfig = async (
	host: Host,
	options: { swarmWorker: boolean; dashboard: boolean },
): Promise<{
	wroteMain: boolean;
	changedMain: boolean;
	wroteMiddlewares: boolean;
}> => {
	let wroteMain = false;
	let changedMain = false;
	const existing = await host.readFile(MAIN_CONFIG_PATH);
	if (existing === null) {
		await host.writeFile(
			MAIN_CONFIG_PATH,
			toYaml(mainTraefikConfig(!options.swarmWorker, options.dashboard)),
		);
		wroteMain = true;
	} else {
		const config = parse(existing) as MainTraefikConfig | null;
		if (
			options.swarmWorker &&
			config?.providers &&
			"swarm" in config.providers
		) {
			delete config.providers.swarm;
			changedMain = true;
		}
		if (config && (config.api?.insecure === true) !== options.dashboard) {
			config.api = { ...config.api, ...apiConfig(options.dashboard) };
			if (!options.dashboard) delete config.api.insecure;
			changedMain = true;
		}
		if (changedMain) {
			await host.writeFile(`${MAIN_CONFIG_PATH}.bak`, existing);
			await host.writeFile(MAIN_CONFIG_PATH, toYaml(config));
		}
	}
	let wroteMiddlewares = false;
	if ((await host.readFile(MIDDLEWARES_PATH)) === null) {
		await host.writeFile(MIDDLEWARES_PATH, toYaml(defaultMiddlewares()));
		wroteMiddlewares = true;
	}
	await host.exec(
		`f=${ACME_PATH}; [ -f "$f" ] && { chmod 600 "$f" 2>/dev/null || sudo -n chmod 600 "$f"; } || true`,
	);
	return { wroteMain, changedMain, wroteMiddlewares };
};

export const updateLetsEncryptEmail = async (
	host: Host,
	email: string,
): Promise<boolean> => {
	const config = await readYaml<MainTraefikConfig>(host, MAIN_CONFIG_PATH);
	const acme = config?.certificatesResolvers?.letsencrypt?.acme;
	if (!config || !acme) {
		throw new Error("Invalid Let's Encrypt configuration structure.");
	}
	if (acme.email === email) return false;
	acme.email = email;
	await host.writeFile(MAIN_CONFIG_PATH, toYaml(config));
	return true;
};

export type PanelRouting = {
	host: string | null;
	https: boolean;
	certificateType: CertificateType;
};

// Traefik routing config for the panel itself.
export const panelRoutingConfig = (
	panel: PanelRouting,
	pathRoutes: PanelPathRoute[] = panelPathRoutes(),
): FileConfig | null => {
	if (!panel.host) return null;
	const hostRule = `Host(\`${new URL(`http://${panel.host}`).hostname}\`)`;
	const routers: Record<string, HttpRouter> = {};
	const services: Record<string, HttpService> = {};
	const middlewares: Record<string, HttpMiddleware> = {};
	const addRouters = (
		name: string,
		rule: string,
		service: string,
		extraMiddlewares: string[],
	) => {
		routers[`panara-cloud-router-${name}`] = {
			rule,
			service,
			entryPoints: ["web"],
			middlewares: [
				...(panel.https ? ["redirect-to-https"] : []),
				...(panel.https ? [] : extraMiddlewares),
			],
		};
		if (panel.https) {
			routers[`panara-cloud-router-${name}-secure`] = {
				rule,
				service,
				entryPoints: ["websecure"],
				...(extraMiddlewares.length > 0 && { middlewares: extraMiddlewares }),
				...(panel.certificateType === "letsencrypt" && {
					tls: { certResolver: "letsencrypt" },
				}),
			};
		}
	};
	const appService = "panara-cloud-service-app";
	services[appService] = {
		loadBalancer: {
			servers: [{ url: PANEL_SERVICE_URL }],
			passHostHeader: true,
		},
	};
	addRouters("app", hostRule, appService, []);
	for (const route of pathRoutes) {
		const service = `panara-cloud-service-${route.name}`;
		services[service] = {
			loadBalancer: { servers: [{ url: route.url }], passHostHeader: true },
		};
		const strip = `panara-cloud-strip-${route.name}`;
		if (route.stripPrefix) {
			middlewares[strip] = { stripPrefix: { prefixes: [route.prefix] } };
		}
		addRouters(
			route.name,
			`${hostRule} && PathPrefix(\`${route.prefix}\`)`,
			service,
			route.stripPrefix ? [strip] : [],
		);
	}
	return {
		http: {
			routers,
			services,
			...(Object.keys(middlewares).length > 0 && { middlewares }),
		},
	};
};

export const writePanelRouting = async (host: Host, panel: PanelRouting) => {
	const config = panelRoutingConfig(panel);
	if (config) {
		await host.writeFile(PANEL_CONFIG_PATH, toYaml(config));
	} else {
		await removeHostPath(host, PANEL_CONFIG_PATH);
	}
};
