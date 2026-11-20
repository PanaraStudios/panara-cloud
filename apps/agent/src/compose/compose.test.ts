import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { RoutingDomain } from "../infra/traefik";
import {
	composeEnvPairs,
	composeLayout,
	deployCommand,
	envFileContent,
	sanitizeCommand,
	shellEnvContent,
	startCommand,
} from "./command";
import {
	addSuffixToAllProperties,
	listServices,
	parseCompose,
	type ResolveInput,
	resolveComposeSpec,
	stringifyCompose,
} from "./transforms";

const FIXTURE = `
services:
  web:
    image: nginx:alpine
    container_name: web
    depends_on: [db]
    links: ["db:database"]
    volumes:
      - data:/var/lib/data
      - logs/sub:/logs:ro
      - ./conf:/etc/conf
      - /srv/abs:/abs
      - \${HOME}/x:/x
      - type: volume
        source: cache
        target: /cache
      - type: bind
        source: ./b
        target: /b
    networks: [backend, panara-cloud-network]
    configs: [app_config, { source: other_config, target: /other }]
    secrets: [token]
  db:
    image: postgres:16
    depends_on:
      cache:
        condition: service_started
    networks:
      backend:
        aliases: [database]
        ipv4_address: 10.5.0.5
    volumes_from: ["web:ro", "container:legacy"]
  cache:
    image: redis
    network_mode: service:db
  worker:
    extends: { service: web }
volumes:
  data: {}
  logs: {}
  cache: {}
networks:
  backend: {}
  panara-cloud-network: { external: true }
configs:
  app_config: { file: ./app.conf }
  other_config: { file: ./other.conf }
secrets:
  token: { file: ./token }
`;

const domain = (fields: Partial<RoutingDomain> = {}): RoutingDomain => ({
	id: "d1",
	host: "app.example.com",
	path: "/",
	port: 80,
	https: false,
	certificateType: "none",
	internalPath: "/",
	stripPath: false,
	middlewares: [],
	enabled: true,
	serviceName: "web",
	...fields,
});

const input = (fields: Partial<ResolveInput> = {}): ResolveInput => ({
	composeId: "c1",
	name: "Shop $tack",
	appName: "shop-abc123",
	composeType: "docker-compose",
	organizationId: "org1",
	projectId: "p1",
	environmentId: "e1",
	randomize: false,
	suffix: "",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	domains: [],
	serviceNetworks: [],
	...fields,
});

describe("randomize (collision suffixing)", () => {
	test("suffixes services, references, volumes, networks, configs and secrets", () => {
		const spec = addSuffixToAllProperties(parseCompose(FIXTURE), "x1");
		expect(Object.keys(spec.services ?? {})).toEqual([
			"web-x1",
			"db-x1",
			"cache-x1",
			"worker-x1",
		]);
		const web = spec.services?.["web-x1"];
		expect(web?.container_name).toBe("web-x1");
		expect(web?.depends_on).toEqual(["db-x1"]);
		expect(web?.links).toEqual(["db-x1:database"]);
		expect(web?.volumes).toEqual([
			"data-x1:/var/lib/data",
			"logs-x1/sub:/logs:ro",
			"./conf:/etc/conf",
			"/srv/abs:/abs",
			"${HOME}/x:/x",
			{ type: "volume", source: "cache-x1", target: "/cache" },
			{ type: "bind", source: "./b", target: "/b" },
		]);
		expect(web?.networks).toEqual(["backend-x1", "panara-cloud-network"]);
		expect(web?.configs).toEqual([
			"app_config-x1",
			{ source: "other_config-x1", target: "/other" },
		]);
		expect(web?.secrets).toEqual(["token-x1"]);

		const db = spec.services?.["db-x1"];
		expect(Object.keys(db?.depends_on as object)).toEqual(["cache-x1"]);
		expect(db?.networks).toEqual({
			"backend-x1": { aliases: ["database"], ipv4_address: "10.5.0.5" },
		});
		expect(db?.volumes_from).toEqual(["web-x1:ro", "container:legacy"]);
		expect(spec.services?.["cache-x1"]?.network_mode).toBe("service:db-x1");
		expect(spec.services?.["worker-x1"]?.extends).toEqual({
			service: "web-x1",
		});

		expect(Object.keys(spec.volumes ?? {})).toEqual([
			"data-x1",
			"logs-x1",
			"cache-x1",
		]);
		expect(Object.keys(spec.networks ?? {})).toEqual([
			"backend-x1",
			"panara-cloud-network",
		]);
		expect(Object.keys(spec.configs as object)).toEqual([
			"app_config-x1",
			"other_config-x1",
		]);
		expect(Object.keys(spec.secrets as object)).toEqual(["token-x1"]);
	});

	test("listServices reflects randomization but not isolation", () => {
		const spec = parseCompose(FIXTURE);
		expect(
			listServices(spec, { ...input(), randomize: true, suffix: "x1" }),
		).toContain("web-x1");
		expect(
			listServices(spec, {
				...input(),
				randomize: true,
				suffix: "x1",
				isolatedDeployment: true,
			}),
		).toEqual(["web", "db", "cache", "worker"]);
		expect(Object.keys(spec.services ?? {})).toContain("web");
	});
});

describe("resolveComposeSpec", () => {
	test("docker compose: Traefik labels, panara-cloud-network and Panara Cloud labels", () => {
		const spec = resolveComposeSpec(
			parseCompose(
				"services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n",
			),
			input({
				domains: [domain({ https: true, certificateType: "letsencrypt" })],
			}),
		);
		const web = spec.services?.web;
		const labels = web?.labels as string[];
		expect(labels).toContain("traefik.enable=true");
		expect(labels).toContain("traefik.docker.network=panara-cloud-network");
		expect(labels).toContain(
			"traefik.http.routers.shop-abc123-d1-web.rule=Host(`app.example.com`)",
		);
		expect(labels).toContain(
			"traefik.http.routers.shop-abc123-d1-websecure.tls.certresolver=letsencrypt",
		);
		expect(labels).toContain("panara-cloud.managed=true");
		expect(labels).toContain("panara-cloud.service.kind=compose");
		expect(labels).toContain("panara-cloud.service.id=c1");
		expect(labels).toContain("panara-cloud.service.name=Shop $$tack");
		expect(labels).toContain("panara-cloud.compose.service=web");
		expect(web?.networks).toEqual(["panara-cloud-network", "default"]);
		expect(spec.services?.db?.networks).toBeUndefined();
		expect(spec.services?.db?.labels).toContain(
			"panara-cloud.compose.service=db",
		);
		expect(spec.networks).toEqual({
			"panara-cloud-network": { external: true },
		});
	});

	test("docker compose services without a restart policy get unless-stopped", () => {
		const spec = resolveComposeSpec(
			parseCompose(
				[
					"services:",
					"  web:",
					"    image: nginx",
					"    depends_on:",
					"      migrate:",
					"        condition: service_completed_successfully",
					"      db:",
					"        condition: service_started",
					"  db:",
					"    image: postgres",
					"    restart: always",
					"  worker:",
					"    image: busybox",
					'    restart: "no"',
					"  migrate:",
					"    image: busybox",
					"  limited:",
					"    image: busybox",
					"    deploy:",
					"      restart_policy:",
					"        condition: on-failure",
					"",
				].join("\n"),
			),
			input(),
		);
		const restart = Object.fromEntries(
			Object.entries(spec.services ?? {}).map(([name, service]) => [
				name,
				service.restart,
			]),
		);
		expect(restart).toEqual({
			web: "unless-stopped",
			db: "always",
			worker: "no",
			migrate: undefined,
			limited: undefined,
		});
	});

	test("stacks keep Swarm's restart policy", () => {
		const spec = resolveComposeSpec(
			parseCompose("services:\n  web:\n    image: nginx\n"),
			input({ composeType: "stack" }),
		);
		expect(spec.services?.web?.restart).toBeUndefined();
	});

	test("redeploying a resolved file does not duplicate labels", () => {
		const options = input({ domains: [domain()] });
		const once = resolveComposeSpec(
			parseCompose("services:\n  web:\n    image: nginx\n"),
			options,
		);
		const twice = resolveComposeSpec(
			parseCompose(stringifyCompose(once)),
			options,
		);
		const labels = (spec: typeof once) =>
			[...((spec.services?.web?.labels as string[]) ?? [])].sort();
		expect(labels(twice)).toEqual(labels(once));
		expect(new Set(labels(twice)).size).toBe(labels(twice).length);
	});

	test("stacks label the service through deploy.labels", () => {
		const spec = resolveComposeSpec(
			parseCompose("services:\n  web:\n    image: nginx\n"),
			input({ composeType: "stack", domains: [domain()] }),
		);
		const deployLabels = spec.services?.web?.deploy?.labels as string[];
		expect(deployLabels).toContain(
			"traefik.swarm.network=panara-cloud-network",
		);
		expect(deployLabels).toContain(
			"traefik.http.services.shop-abc123-d1-web.loadbalancer.server.port=80",
		);
		expect(deployLabels).toContain("panara-cloud.service.id=c1");
		expect(spec.services?.web?.labels).toContain("panara-cloud.service.id=c1");
	});

	test("isolated deployments join their own network instead of panara-cloud-network", () => {
		const spec = resolveComposeSpec(
			parseCompose(FIXTURE),
			input({
				isolatedDeployment: true,
				isolatedDeploymentsVolume: true,
				randomize: true,
				suffix: "ignored",
				domains: [domain()],
			}),
		);
		expect(spec.networks?.["shop-abc123"]).toEqual({
			name: "shop-abc123",
			external: true,
		});
		const web = spec.services?.web;
		expect(web?.networks).toEqual([
			"backend",
			"panara-cloud-network",
			"shop-abc123",
		]);
		expect(web?.labels).toContain("traefik.docker.network=shop-abc123");
		expect(spec.services?.db?.networks).toHaveProperty("shop-abc123");
		expect(spec.services?.cache?.networks).toBeUndefined();
		expect(spec.services?.worker?.networks).toEqual(["shop-abc123"]);
		expect((web?.volumes as unknown[])[0]).toBe(
			"data-shop-abc123:/var/lib/data",
		);
		expect(Object.keys(spec.volumes ?? {})).toContain("data-shop-abc123");
	});

	test("service networks can detach a service from panara-cloud-network", () => {
		const spec = resolveComposeSpec(
			parseCompose(
				"services:\n  web:\n    image: nginx\n  api:\n    image: api\n",
			),
			input({
				domains: [domain()],
				serviceNetworks: [
					{
						serviceName: "web",
						networks: ["edge"],
						detachPanaraCloudNetwork: true,
					},
					{
						serviceName: "api",
						networks: ["edge"],
						detachPanaraCloudNetwork: false,
					},
				],
			}),
		);
		expect(spec.services?.web?.networks).toEqual(["edge"]);
		expect(spec.services?.web?.labels).not.toContain(
			"traefik.docker.network=panara-cloud-network",
		);
		expect(spec.services?.api?.networks).toEqual(["edge", "default"]);
		expect(spec.networks).toEqual({ edge: { external: true } });
	});

	test("domains must name an existing service", () => {
		expect(() =>
			resolveComposeSpec(
				parseCompose("services:\n  web:\n    image: nginx\n"),
				input({ domains: [domain({ serviceName: "api" })] }),
			),
		).toThrow(/does not exist/);
		expect(() => parseCompose("")).toThrow(/empty/);
	});
});

describe("commands and files", () => {
	const commandInput = {
		appName: "shop-abc123",
		composeType: "docker-compose" as const,
		command: "",
		createEnvFile: true,
		pullImages: false,
		hasMounts: false,
	};

	test("layout keeps the compose file inside the code directory", () => {
		const raw = composeLayout({
			appName: "shop-abc123",
			sourceType: "raw",
			composePath: "../../etc/passwd",
		});
		expect(raw.composeFile).toBe(
			"/etc/panara-cloud/compose/shop-abc123/code/docker-compose.yml",
		);
		expect(raw.envFileRelative).toBe(".env");
		const git = composeLayout({
			appName: "shop-abc123",
			sourceType: "git",
			composePath: "./deploy/compose.yml",
		});
		expect(git.composeFileRelative).toBe("deploy/compose.yml");
		expect(git.envFile).toBe(
			"/etc/panara-cloud/compose/shop-abc123/code/deploy/.env",
		);
		expect(() =>
			composeLayout({
				appName: "shop-abc123",
				sourceType: "git",
				composePath: "deploy/../../x.yml",
			}),
		).toThrow(/Invalid compose path/);
		expect(() =>
			composeLayout({ appName: "../x", sourceType: "raw", composePath: "" }),
		).toThrow(/Invalid appName/);
	});

	test("deploy and start commands", () => {
		const layout = composeLayout({
			appName: "shop-abc123",
			sourceType: "git",
			composePath: "deploy/compose.yml",
		});
		expect(deployCommand(commandInput, layout)).toBe(
			"compose -p shop-abc123 --env-file deploy/.env -f deploy/compose.yml up -d --build --remove-orphans",
		);
		expect(
			deployCommand(
				{
					...commandInput,
					hasMounts: true,
					pullImages: true,
					createEnvFile: false,
				},
				layout,
			),
		).toBe(
			"compose -p shop-abc123 --project-directory /etc/panara-cloud/compose/shop-abc123/code -f deploy/compose.yml up -d --build --remove-orphans --pull always",
		);
		expect(
			deployCommand({ ...commandInput, composeType: "stack" }, layout),
		).toBe(
			"stack deploy -c deploy/compose.yml shop-abc123 --prune --with-registry-auth",
		);
		expect(startCommand(commandInput, layout)).toBe(
			"compose -p shop-abc123 --env-file deploy/.env -f deploy/compose.yml up -d",
		);
		expect(
			deployCommand(
				{
					...commandInput,
					command: 'compose -p x "up" -d && docker compose -p x ps',
				},
				layout,
			),
		).toBe("compose -p x up -d && docker compose -p x ps");
	});

	test("custom commands cannot escape to the shell", () => {
		for (const bad of [
			"compose up; rm -rf /",
			"compose up | tee x",
			"compose up $(id)",
			"compose up `id`",
			"compose up & sleep 1",
			"compose up && rm -rf /",
		]) {
			expect(() => sanitizeCommand(bad)).toThrow();
		}
	});

	test("env files: compose escaping, raw for stacks, shell exports", () => {
		const pairs = composeEnvPairs({
			appName: "shop-abc123",
			env: 'PASSWORD=pa$$"w\nREF=${{project.SHARED}}',
			projectEnv: "SHARED=from-project",
			environmentEnv: "",
			randomize: true,
			suffix: "x1",
		});
		expect(pairs).toEqual([
			"APP_NAME=shop-abc123",
			"COMPOSE_PROJECT_NAME=shop-abc123",
			'PASSWORD=pa$$"w',
			"REF=from-project",
			"COMPOSE_PREFIX=x1",
		]);
		expect(envFileContent(pairs, "docker-compose")).toContain(
			'PASSWORD="pa\\$\\$\\"w"',
		);
		expect(envFileContent(pairs, "stack")).toContain('PASSWORD=pa$$"w');
		const script = `set -e\n${shellEnvContent(pairs)}printf '%s' "$PASSWORD"`;
		const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
		expect(run.stdout).toBe('pa$$"w');
	});
});
