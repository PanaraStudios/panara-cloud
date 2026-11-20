import type { Host } from "../../host/types";
import { paths } from "../../lib/constants";
import { removeHostPath } from "../shell";
import { toYaml } from "./config";
import type { CertificateType, FileConfig, HttpRouter } from "./types";

export type RoutingDomain = {
	// Stable id (the backend domain id); names the routers and middlewares.
	id: string;
	host: string;
	path: string;
	port: number;
	https: boolean;
	certificateType: CertificateType;
	customCertResolver?: string;
	customEntrypoint?: string;
	internalPath: string;
	stripPath: boolean;
	middlewares: string[];
	enabled: boolean;
	serviceName?: string;
};

export type RoutingRedirect = {
	id: string;
	regex: string;
	replacement: string;
	permanent: boolean;
};

export type RoutingBasicAuthUser = {
	username: string;
	// apr1/bcrypt hash as stored by the backend; never a plaintext password.
	passwordHash: string;
};

// What a swarm service needs to be reachable through Traefik. Matches the
// backend's RoutingSnapshot (convex/infra/routing.ts), so a deploy context can
// pass it through unchanged.
export type ServiceRoutingInput = {
	appName: string;
	// Host name of the upstream on panara-cloud-network; defaults to appName (the
	// swarm service name).
	upstreamHost?: string;
	domains: RoutingDomain[];
	redirects: RoutingRedirect[];
	basicAuth: RoutingBasicAuthUser[];
};

const SAFE_APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export const routingFilePath = (appName: string): string => {
	if (!SAFE_APP_NAME.test(appName))
		throw new Error(`Invalid appName: ${appName}`);
	return `${paths.traefikDynamic}/${appName}.yml`;
};

// Traefik needs ASCII hosts, so IDNs become punycode.
const toPunycode = (host: string): string => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		return host;
	}
};

const routerRule = (domain: RoutingDomain) =>
	`Host(\`${toPunycode(domain.host)}\`)${domain.path && domain.path !== "/" ? ` && PathPrefix(\`${domain.path}\`)` : ""}`;

export const middlewareNames = (appName: string, domainId: string) => ({
	stripPrefix: `stripprefix-${appName}-${domainId}`,
	addPrefix: `addprefix-${appName}-${domainId}`,
	basicAuth: `auth-${appName}`,
	redirect: (redirectId: string) => `redirect-${appName}-${redirectId}`,
});

const needsStripPrefix = (domain: RoutingDomain) =>
	domain.stripPath && domain.path !== "/";

const needsAddPrefix = (domain: RoutingDomain) =>
	domain.internalPath !== "/" && domain.internalPath !== domain.path;

// Router config: the plain-HTTP router of an HTTPS domain only
// redirects; every other middleware runs where the request lands.
const createRouter = (
	input: ServiceRoutingInput,
	domain: RoutingDomain,
	entryPoint: string,
): HttpRouter => {
	const names = middlewareNames(input.appName, domain.id);
	const router: HttpRouter = {
		rule: routerRule(domain),
		service: `${input.appName}-service-${domain.id}`,
		entryPoints: [entryPoint],
		middlewares: [],
	};
	const middlewares = router.middlewares as string[];
	const isRedirectRouter =
		entryPoint === "web" && domain.https && !domain.customEntrypoint;
	if (isRedirectRouter) {
		middlewares.push("redirect-to-https");
	} else {
		if (needsStripPrefix(domain)) middlewares.push(names.stripPrefix);
		if (needsAddPrefix(domain)) middlewares.push(names.addPrefix);
		for (const redirect of input.redirects) {
			middlewares.push(names.redirect(redirect.id));
		}
		if (input.basicAuth.length > 0) middlewares.push(names.basicAuth);
		middlewares.push(...domain.middlewares);
	}
	if (entryPoint === "websecure" || (domain.customEntrypoint && domain.https)) {
		if (domain.certificateType === "letsencrypt") {
			router.tls = { certResolver: "letsencrypt" };
		} else if (
			domain.certificateType === "custom" &&
			domain.customCertResolver
		) {
			router.tls = { certResolver: domain.customCertResolver };
		} else if (domain.customEntrypoint) {
			router.tls = {};
		}
	}
	return router;
};

// The complete Traefik file for one service: routers, services and the
// middlewares only it uses. Writing the whole file per service keeps
// reconciles idempotent and leaves no shared file to merge into.
export const buildServiceRoutingConfig = (
	input: ServiceRoutingInput,
): FileConfig | null => {
	const domains = input.domains.filter((domain) => domain.enabled);
	if (domains.length === 0) return null;
	const upstream = input.upstreamHost ?? input.appName;
	const routers: Record<string, HttpRouter> = {};
	const services: NonNullable<FileConfig["http"]>["services"] = {};
	const middlewares: NonNullable<FileConfig["http"]>["middlewares"] = {};

	for (const domain of domains) {
		const names = middlewareNames(input.appName, domain.id);
		routers[`${input.appName}-router-${domain.id}`] = createRouter(
			input,
			domain,
			domain.customEntrypoint || "web",
		);
		if (!domain.customEntrypoint && domain.https) {
			routers[`${input.appName}-router-websecure-${domain.id}`] = createRouter(
				input,
				domain,
				"websecure",
			);
		}
		services[`${input.appName}-service-${domain.id}`] = {
			loadBalancer: {
				servers: [{ url: `http://${upstream}:${domain.port || 80}` }],
				passHostHeader: true,
			},
		};
		if (needsStripPrefix(domain)) {
			middlewares[names.stripPrefix] = {
				stripPrefix: { prefixes: [domain.path] },
			};
		}
		if (needsAddPrefix(domain)) {
			middlewares[names.addPrefix] = {
				addPrefix: { prefix: domain.internalPath },
			};
		}
	}
	const names = middlewareNames(input.appName, "");
	for (const redirect of input.redirects) {
		middlewares[names.redirect(redirect.id)] = {
			redirectRegex: {
				regex: redirect.regex,
				replacement: redirect.replacement,
				permanent: redirect.permanent,
			},
		};
	}
	if (input.basicAuth.length > 0) {
		middlewares[names.basicAuth] = {
			basicAuth: {
				removeHeader: true,
				users: input.basicAuth.map(
					(user) => `${user.username}:${user.passwordHash}`,
				),
			},
		};
	}
	return {
		http: {
			routers,
			services,
			...(Object.keys(middlewares).length > 0 && { middlewares }),
		},
	};
};

// Writes (or, with no enabled domains, removes) the service's Traefik file.
// Traefik's file provider picks the change up without a restart.
export const writeServiceRouting = async (
	host: Host,
	input: ServiceRoutingInput,
): Promise<{ path: string; routers: number; removed: boolean }> => {
	const path = routingFilePath(input.appName);
	const config = buildServiceRoutingConfig(input);
	if (!config) {
		await removeHostPath(host, path);
		return { path, routers: 0, removed: true };
	}
	await host.writeFile(path, toYaml(config));
	return {
		path,
		routers: Object.keys(config.http?.routers ?? {}).length,
		removed: false,
	};
};

export const removeServiceRouting = async (
	host: Host,
	appName: string,
): Promise<void> => {
	await removeHostPath(host, routingFilePath(appName));
};
