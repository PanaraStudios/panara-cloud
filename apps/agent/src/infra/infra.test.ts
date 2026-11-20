import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
	cleanupCommandsFor,
	containerListFilters,
	dockerSafeExec,
	nodeTlsStatus,
	parseSwarmServices,
	parseSwarmTasks,
} from "./docker";
import { auditScript, setupScript, validateScript } from "./setup";
import { DOCKER_PREAMBLE, SUDO_PREAMBLE } from "./shell";
import {
	addDomainsToCompose,
	buildServiceRoutingConfig,
	type ComposeSpec,
	type RoutingDomain,
	routingFilePath,
} from "./traefik";
import { panelPathRoutes, panelRoutingConfig } from "./traefik/config";
import { resolveTraefikPath } from "./traefik/files";

const domain = (fields: Partial<RoutingDomain> = {}): RoutingDomain => ({
	id: "d1",
	host: "app.example.com",
	path: "/",
	port: 3000,
	https: false,
	certificateType: "none",
	internalPath: "/",
	stripPath: false,
	middlewares: [],
	enabled: true,
	...fields,
});

const bashSyntaxOk = (script: string) =>
	spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

describe("service routing", () => {
	test("https domains get a redirect-only web router and a TLS router", () => {
		const config = buildServiceRoutingConfig({
			appName: "web",
			domains: [
				domain({
					https: true,
					certificateType: "letsencrypt",
					path: "/api",
					stripPath: true,
					internalPath: "/v1",
					middlewares: ["ratelimit@file"],
				}),
			],
			redirects: [
				{ id: "r1", regex: "^/a", replacement: "/b", permanent: true },
			],
			basicAuth: [{ username: "u", passwordHash: "$apr1$x$y" }],
		});
		expect(config?.http?.routers?.["web-router-d1"]).toEqual({
			rule: "Host(`app.example.com`) && PathPrefix(`/api`)",
			service: "web-service-d1",
			entryPoints: ["web"],
			middlewares: ["redirect-to-https"],
		});
		expect(config?.http?.routers?.["web-router-websecure-d1"]).toEqual({
			rule: "Host(`app.example.com`) && PathPrefix(`/api`)",
			service: "web-service-d1",
			entryPoints: ["websecure"],
			middlewares: [
				"stripprefix-web-d1",
				"addprefix-web-d1",
				"redirect-web-r1",
				"auth-web",
				"ratelimit@file",
			],
			tls: { certResolver: "letsencrypt" },
		});
		expect(config?.http?.services?.["web-service-d1"]).toEqual({
			loadBalancer: {
				servers: [{ url: "http://web:3000" }],
				passHostHeader: true,
			},
		});
		expect(config?.http?.middlewares).toEqual({
			"stripprefix-web-d1": { stripPrefix: { prefixes: ["/api"] } },
			"addprefix-web-d1": { addPrefix: { prefix: "/v1" } },
			"redirect-web-r1": {
				redirectRegex: { regex: "^/a", replacement: "/b", permanent: true },
			},
			"auth-web": { basicAuth: { removeHeader: true, users: ["u:$apr1$x$y"] } },
		});
	});

	test("disabled domains are dropped and no domains means no file", () => {
		expect(
			buildServiceRoutingConfig({
				appName: "web",
				domains: [domain({ enabled: false })],
				redirects: [],
				basicAuth: [],
			}),
		).toBeNull();
	});

	test("IDN hosts become punycode and custom entrypoints carry TLS", () => {
		const config = buildServiceRoutingConfig({
			appName: "web",
			upstreamHost: "web-blue",
			domains: [
				domain({ host: "тест.рф", customEntrypoint: "alt", https: true }),
			],
			redirects: [],
			basicAuth: [],
		});
		expect(config?.http?.routers?.["web-router-d1"]).toMatchObject({
			rule: "Host(`xn--e1aybc.xn--p1ai`)",
			entryPoints: ["alt"],
			tls: {},
		});
		expect(config?.http?.routers?.["web-router-websecure-d1"]).toBeUndefined();
		expect(
			config?.http?.services?.["web-service-d1"]?.loadBalancer.servers,
		).toEqual([{ url: "http://web-blue:3000" }]);
	});

	test("app names and Traefik file paths can't escape their directories", () => {
		expect(() => routingFilePath("../etc")).toThrow();
		expect(routingFilePath("web-1")).toBe(
			"/etc/panara-cloud/traefik/dynamic/web-1.yml",
		);
		expect(() => resolveTraefikPath("../../etc/shadow")).toThrow();
		expect(() => resolveTraefikPath("dynamic/acme.json")).toThrow();
		expect(() =>
			resolveTraefikPath("dynamic/certificates/certificate-ab12/privkey.key"),
		).toThrow(/not accessible/);
		expect(() =>
			resolveTraefikPath("dynamic/./certificates/c/../c/privkey.key"),
		).toThrow(/not accessible/);
		expect(
			resolveTraefikPath("dynamic/certificates/certificate-ab12/chain.crt"),
		).toBe(
			"/etc/panara-cloud/traefik/dynamic/certificates/certificate-ab12/chain.crt",
		);
		expect(resolveTraefikPath("dynamic/x.yml")).toBe(
			"/etc/panara-cloud/traefik/dynamic/x.yml",
		);
	});

	test("panel routing redirects to HTTPS when enabled", () => {
		const config = panelRoutingConfig({
			host: "panel.example.com",
			https: true,
			certificateType: "letsencrypt",
		});
		expect(
			config?.http?.routers?.["panara-cloud-router-app"]?.middlewares,
		).toEqual(["redirect-to-https"]);
		expect(
			config?.http?.routers?.["panara-cloud-router-app-secure"]?.tls,
		).toEqual({
			certResolver: "letsencrypt",
		});
		expect(
			panelRoutingConfig({ host: null, https: false, certificateType: "none" }),
		).toBeNull();
	});
});

describe("panel path routes", () => {
	const routes = panelPathRoutes({
		PANARA_CLOUD_CONVEX_UPSTREAM: "http://panara-cloud-convex:3210",
		PANARA_CLOUD_CONVEX_SITE_UPSTREAM: "http://panara-cloud-convex:3211",
		PANARA_CLOUD_LIVE_UPSTREAM: "http://panara-cloud-agent:7100",
	});

	test("only configured upstreams are routed", () => {
		expect(panelPathRoutes({})).toEqual([]);
		expect(routes.map((route) => route.prefix)).toEqual([
			"/convex",
			"/api/actions",
			"/convex-site",
			"/live",
		]);
	});

	test("Convex paths are stripped, /live is passed through", () => {
		const config = panelRoutingConfig(
			{
				host: "panel.example.com",
				https: true,
				certificateType: "letsencrypt",
			},
			routes,
		);
		const routers = config?.http?.routers ?? {};
		expect(routers["panara-cloud-router-convex-secure"]).toEqual({
			rule: "Host(`panel.example.com`) && PathPrefix(`/convex`)",
			service: "panara-cloud-service-convex",
			entryPoints: ["websecure"],
			middlewares: ["panara-cloud-strip-convex"],
			tls: { certResolver: "letsencrypt" },
		});
		expect(routers["panara-cloud-router-convex"]?.middlewares).toEqual([
			"redirect-to-https",
		]);
		expect(routers["panara-cloud-router-live-secure"]?.middlewares).toBe(
			undefined,
		);
		expect(routers["panara-cloud-router-convex-actions-secure"]).toMatchObject({
			rule: "Host(`panel.example.com`) && PathPrefix(`/api/actions`)",
			service: "panara-cloud-service-convex-actions",
		});
		expect(
			routers["panara-cloud-router-convex-actions-secure"]?.middlewares,
		).toBe(undefined);
		expect(config?.http?.middlewares).toEqual({
			"panara-cloud-strip-convex": { stripPrefix: { prefixes: ["/convex"] } },
			"panara-cloud-strip-convex-site": {
				stripPrefix: { prefixes: ["/convex-site"] },
			},
		});
		expect(
			config?.http?.services?.["panara-cloud-service-live"]?.loadBalancer
				.servers,
		).toEqual([{ url: "http://panara-cloud-agent:7100" }]);
	});

	test("without HTTPS the strip middleware runs on the web entry point", () => {
		const config = panelRoutingConfig(
			{ host: "10.0.0.5", https: false, certificateType: "none" },
			routes,
		);
		expect(
			config?.http?.routers?.["panara-cloud-router-convex-site"]?.middlewares,
		).toEqual(["panara-cloud-strip-convex-site"]);
		expect(
			config?.http?.routers?.["panara-cloud-router-convex-site-secure"],
		).toBeUndefined();
	});
});

describe("compose labels", () => {
	test("adds labels to the routed service and joins panara-cloud-network", () => {
		const spec: ComposeSpec = {
			services: {
				web: {
					image: "nginx",
					labels: ["traefik.http.routers.app-d1-web.rule=old"],
				},
				db: { image: "postgres" },
			},
		};
		addDomainsToCompose(spec, {
			appName: "app",
			composeType: "docker-compose",
			domains: [
				domain({
					serviceName: "web",
					https: true,
					certificateType: "letsencrypt",
				}),
			],
		});
		const labels = spec.services?.web?.labels as string[];
		expect(labels).toContain("traefik.enable=true");
		expect(labels).toContain("traefik.docker.network=panara-cloud-network");
		expect(labels).toContain(
			"traefik.http.routers.app-d1-web.middlewares=redirect-to-https@file",
		);
		expect(labels).toContain(
			"traefik.http.routers.app-d1-websecure.tls.certresolver=letsencrypt",
		);
		expect(labels).not.toContain("traefik.http.routers.app-d1-web.rule=old");
		expect(spec.services?.web?.networks).toEqual([
			"panara-cloud-network",
			"default",
		]);
		expect(spec.services?.db?.networks).toBeUndefined();
		expect(spec.networks).toEqual({
			"panara-cloud-network": { external: true },
		});
	});

	test("stacks use deploy labels and the swarm network label", () => {
		const spec: ComposeSpec = { services: { web: { image: "nginx" } } };
		addDomainsToCompose(spec, {
			appName: "app",
			composeType: "stack",
			domains: [domain({ serviceName: "web" })],
		});
		expect(spec.services?.web?.labels).toBeUndefined();
		expect(spec.services?.web?.deploy?.labels).toContain(
			"traefik.swarm.network=panara-cloud-network",
		);
	});

	test("rejects domains for unknown services", () => {
		expect(() =>
			addDomainsToCompose(
				{ services: {} },
				{
					appName: "a",
					composeType: "stack",
					domains: [domain({ serviceName: "x" })],
				},
			),
		).toThrow(/does not exist/);
	});
});

describe("host scripts", () => {
	test("generated scripts are valid bash", () => {
		for (const script of [
			setupScript({ serverType: "deploy", advertiseAddr: "10.0.0.1" }),
			setupScript({ serverType: "build" }),
			`${SUDO_PREAMBLE}\n${DOCKER_PREAMBLE}\n${validateScript}`,
			`${SUDO_PREAMBLE}\n${auditScript}`,
			...cleanupCommandsFor("all"),
			...cleanupCommandsFor("patches"),
			...cleanupCommandsFor("monitoring"),
			dockerSafeExec("true"),
		]) {
			const result = bashSyntaxOk(script);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		}
	});

	test("build servers skip swarm, network and Traefik", () => {
		const script = setupScript({ serverType: "build" });
		expect(script).not.toContain("docker swarm init");
		expect(script).not.toContain("network create");
		expect(setupScript({ serverType: "deploy" })).toContain(
			"network create --driver overlay --attachable panara-cloud-network",
		);
	});

	test("scheduled cleanup never prunes volumes", () => {
		expect(cleanupCommandsFor("all").join("\n")).not.toContain("volume prune");
		expect(cleanupCommandsFor("volumes").join("\n")).toContain("volume prune");
	});

	test("patch and monitoring cleanups only touch their directories", () => {
		expect(cleanupCommandsFor("patches")).toEqual([
			"$SUDO rm -rf /etc/panara-cloud/patch-repos/* 2>/dev/null || true",
		]);
		const [monitoring] = cleanupCommandsFor("monitoring");
		expect(monitoring).toContain("rm -rf /etc/panara-cloud/monitoring");
		expect(monitoring).toContain("mkdir -p /etc/panara-cloud/monitoring");
		expect(cleanupCommandsFor("all").join("\n")).not.toContain("patch-repos");
	});
});

describe("swarm services", () => {
	test("hides the panel's own services and keeps the listed fields", () => {
		const output = [
			JSON.stringify({
				ID: "s1",
				Name: "web-abc",
				Mode: "replicated",
				Replicas: "1/1",
				Image: "nginx:1",
				Ports: "",
				Extra: "dropped",
			}),
			JSON.stringify({ ID: "s2", Name: "panara-cloud-monitoring" }),
			"not json",
		].join("\n");
		expect(parseSwarmServices(output)).toEqual([
			{
				ID: "s1",
				Name: "web-abc",
				Mode: "replicated",
				Replicas: "1/1",
				Image: "nginx:1",
				Ports: "",
			},
		]);
	});

	test("tasks keep name, node and state fields", () => {
		const [task] = parseSwarmTasks(
			JSON.stringify({
				ID: "t1",
				Name: "web-abc.1",
				Image: "nginx:1",
				Node: "node-1",
				DesiredState: "Running",
				CurrentState: "Running 2 hours ago",
				Error: "",
				Ports: "",
			}),
		);
		expect(task).toMatchObject({
			Name: "web-abc.1",
			Node: "node-1",
			CurrentState: "Running 2 hours ago",
		});
	});
});

describe("service containers", () => {
	test("filters by compose project, stack namespace or name", () => {
		expect(containerListFilters("shop", "docker-compose")).toEqual({
			label: ["com.docker.compose.project=shop"],
		});
		expect(containerListFilters("shop", "stack")).toEqual({
			label: ["com.docker.stack.namespace=shop"],
		});
		expect(containerListFilters("shop", undefined)).toEqual({
			label: ["com.docker.swarm.service.name=shop"],
		});
		expect(containerListFilters("shop", "swarm")).toEqual({
			label: ["com.docker.swarm.service.name=shop"],
		});
		expect(containerListFilters("panara-cloud", "standalone")).toEqual({
			name: ["panara-cloud"],
		});
	});

	test("an organization restriction adds its label", () => {
		expect(containerListFilters("shop", undefined, "org1")).toEqual({
			label: [
				"com.docker.swarm.service.name=shop",
				"panara-cloud.organization=org1",
			],
		});
		expect(containerListFilters("panara-cloud", "standalone", "org1")).toEqual({
			name: ["panara-cloud"],
			label: ["panara-cloud.organization=org1"],
		});
	});
});

describe("swarm nodes", () => {
	const tls = {
		TrustRoot: "root",
		CertIssuerSubject: "s",
		CertIssuerPublicKey: "k",
	};
	test("TLS status follows docker node ls", () => {
		expect(nodeTlsStatus(tls, tls)).toBe("Ready");
		expect(nodeTlsStatus({ ...tls, TrustRoot: "old" }, tls)).toBe(
			"Needs Rotation",
		);
		expect(nodeTlsStatus(undefined, tls)).toBe("Unknown");
		expect(nodeTlsStatus(tls, {})).toBe("Unknown");
	});
});
