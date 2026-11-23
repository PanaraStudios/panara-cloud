import { describe, expect, test } from "vitest";
import type { ExecOptions, Host } from "../host/types";
import { type ComposeJobInput, deployCompose, startCompose } from "./host";
import {
	assertCommandPolicy,
	assertComposePolicy,
	composeHostPaths,
	composePolicyProblems,
} from "./policy";
import { parseCompose } from "./transforms";

const base = "/etc/panara-cloud/compose/shop-abc";
const scope = {
	base,
	relativeTo: [`${base}/code`, `${base}/code/deploy`],
	ownedHosts: ["shop.example.com"],
	appName: "shop-abc",
	fileMounts: [`${base}/files/app.conf`],
};
const problems = (yaml: string) =>
	composePolicyProblems(parseCompose(yaml), scope);

describe("untrusted compose files", () => {
	test("host-level settings are refused", () => {
		const found = problems(`
services:
  a:
    image: alpine
    privileged: true
    pid: host
    network_mode: host
    ipc: "container:other"
    cap_add: [SYS_ADMIN]
    devices: ["/dev/sda:/dev/sda"]
    security_opt: ["seccomp:unconfined"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host
      - ../../../../../etc:/etc-host
      - \${HOME}:/home
      - type: bind
        source: /root
        target: /r
    env_file: /etc/panara-cloud/secrets/env
    build:
      context: /
    labels:
      - "traefik.http.routers.steal.rule=Host(\`panel.example.com\`)"
  b:
    image: alpine
    deploy:
      labels:
        traefik.http.routers.any.rule: "HostRegexp(\`.+\`)"
configs:
  c:
    file: /etc/shadow
volumes:
  v:
    driver: local
    driver_opts: { type: none, o: bind, device: / }
`);
		for (const expected of [
			"services.a.privileged",
			"services.a.pid: host",
			"services.a.network_mode: host",
			"services.a.ipc: container:other",
			"services.a.cap_add: SYS_ADMIN",
			"services.a.devices",
			"services.a.security_opt: seccomp:unconfined",
			'host path "/var/run/docker.sock"',
			'host path "/"',
			'host path "../../../../../etc"',
			'host path "${HOME}"',
			'host path "/root"',
			"services.a.env_file",
			"services.a.build.context",
			"panel.example.com, which is not one of this service's domains",
			"services.b.labels traefik.http.routers.any.rule must match only",
			"configs.c.file",
			"volumes.v.driver_opts",
		]) {
			expect(found.join("\n")).toContain(expected);
		}
	});

	test("ordinary compose files pass", () => {
		expect(
			problems(`
services:
  web:
    build: .
    cap_add: [NET_BIND_SERVICE]
    security_opt: [no-new-privileges:true]
    env_file: [.env]
    network_mode: "service:db"
    volumes:
      - data:/data
      - ./config:/config:ro
      - ../files/app.conf:/etc/app.conf
      - type: tmpfs
        target: /tmp
    labels:
      traefik.http.routers.web.rule: "Host(\`shop.example.com\`) && PathPrefix(\`/api\`)"
  db:
    image: postgres
volumes:
  data: {}
`),
		).toEqual([]);
	});

	test("Docker's own labels can't be forged", () => {
		expect(
			problems(`
services:
  a:
    image: alpine
    labels: { com.docker.swarm.service.name: victim-abc }
    deploy: { labels: [com.docker.stack.namespace=victim] }
`).join("\n"),
		).toMatch(
			/swarm\.service\.name is set by Docker[\s\S]*stack\.namespace is set by Docker/,
		);
	});

	test("Traefik rules may only narrow the service's own hosts", () => {
		const rule = (value: string) =>
			problems(
				`services:\n  a:\n    image: alpine\n    labels:\n      traefik.http.routers.a.rule: "${value}"\n`,
			);
		for (const value of [
			"Host(`shop.example.com`) || PathPrefix(`/`)",
			"!Host(`shop.example.com`)",
			"PathPrefix(`/`) || Host(`shop.example.com`)",
			"Host(`shop.example.com`) && PathPrefix(`/`) || Host(`panel.example.com`)",
			"(Host(`shop.example.com`) || PathPrefix(`/`))",
			"HostSNI(`*`)",
			"Host(`shop.example.com`) && (PathPrefix(`/`)",
		]) {
			expect(rule(value), value).not.toEqual([]);
		}
		for (const value of [
			"Host(`shop.example.com`)",
			"Host(`shop.example.com`) && PathPrefix(`/api`)",
			"Host(`shop.example.com`) && (PathPrefix(`/a`) || PathPrefix(`/b`))",
			"Host(`shop.example.com`) || Host(`SHOP.example.com`) && Path(`/x`)",
		]) {
			expect(rule(value), value).toEqual([]);
		}
	});

	test("reserved and foreign volumes, networks and ports are refused", () => {
		const found = problems(`
services:
  a:
    image: alpine
    volumes: ["d:/data", "o:/other"]
    ports: ["80:80", "127.0.0.1:443:443/udp", { target: 1, published: "3210" }, "8000-8080:9000"]
    networks: [internal]
volumes:
  d: { external: true, name: panara-cloud-convex-data }
  o: { name: other-app_data }
networks:
  internal: { external: true, name: panara-cloud-internal }
`).join("\n");
		for (const expected of [
			"volumes.d: external volumes",
			'name "panara-cloud-convex-data" belongs to another service',
			'name "other-app_data" belongs to another service',
			"ports: 80 is reserved",
			"ports: 443 is reserved",
			"ports: 3210 is reserved",
			'external network "panara-cloud-internal"',
		]) {
			expect(found).toContain(expected);
		}
		expect(
			problems(`
services:
  a:
    image: alpine
    ports: ["8080:80"]
    networks: [panara-cloud-network]
volumes:
  d: { name: shop-abc_d }
networks:
  panara-cloud-network: { external: true }
`),
		).toEqual([]);
	});

	test("canonical values from docker compose config are caught", () => {
		const found = problems(`
services:
  a:
    image: alpine
    privileged: "yes"
    network_mode: "host "
    runtime: runc-unsafe
    use_api_socket: true
    build: { context: ., ssh: [default], network: host }
    post_start: [{ command: id, privileged: true }]
    volumes:
      - { type: bind, source: ${base}/files, target: /f }
      - { type: bind, source: ${base}, target: /b }
models: { m: {} }
`).join("\n");
		for (const expected of [
			"services.a.privileged",
			"services.a.network_mode",
			"services.a.runtime",
			"services.a.use_api_socket",
			"services.a.build.ssh",
			"services.a.build.network",
			"lifecycle hook privileged",
			`host path "${base}/files"`,
			`host path "${base}"`,
			"models (top-level)",
		]) {
			expect(found).toContain(expected);
		}
	});

	test("bind sources are judged by their real path on the host", () => {
		const spec = parseCompose(
			"services:\n  a:\n    image: alpine\n    volumes: ['./data/link:/h']\n",
		);
		const path = `${base}/code/data/link`;
		expect(composeHostPaths(spec, scope)).toContain(path);
		expect(composePolicyProblems(spec, scope)).toEqual([]);
		expect(
			composePolicyProblems(spec, {
				...scope,
				realPaths: new Map([[path, "/"]]),
			}),
		).not.toEqual([]);
	});

	test("the error names every refused setting", () => {
		expect(() =>
			assertComposePolicy(
				parseCompose("services:\n  a:\n    privileged: true\n"),
				scope,
			),
		).toThrow(/instance administrator[\s\S]*services\.a\.privileged/);
	});
});

describe("untrusted custom commands", () => {
	test("only docker compose on the service's own files", () => {
		for (const command of [
			"run --privileged -v /:/h alpine",
			"compose up -d && docker run --privileged alpine",
			"compose run -v /:/h web",
			"compose -f /etc/x.yml up",
			"compose --project-directory / up",
			"compose cp web:/x .",
			"compose --env-file ../../../../etc/panara-cloud/secrets/env up",
			"stack deploy -c /etc/x.yml app",
		]) {
			expect(() => assertCommandPolicy(command), command).toThrow();
		}
		for (const command of [
			"compose -p shop -f docker-compose.yml up -d --build",
			"compose up -d && docker compose logs",
			"compose --profile web up -d",
			"stack deploy -c docker-compose.yml shop --prune",
		]) {
			expect(() => assertCommandPolicy(command), command).not.toThrow();
		}
	});
});

describe("deployCompose", () => {
	const yaml = "services:\n  a:\n    image: alpine\n    privileged: true\n";
	const host = () => {
		const commands: string[] = [];
		const fake = {
			kind: "ssh",
			label: "fake",
			exec: async (command: string, options?: ExecOptions) => {
				commands.push(command, options?.input ?? "");
				if (command.includes(" config --no-env-resolution")) {
					return {
						code: 0,
						output: JSON.stringify({
							services: { a: { image: "alpine", privileged: true } },
						}),
					};
				}
				return {
					code: 0,
					output: command.includes("realpath") ? yaml : "",
				};
			},
			run: async () => "",
			writeFile: async () => {},
			readFile: async () => null,
		} as unknown as Host;
		return { fake, commands };
	};
	const input = (trusted: boolean, command = ""): ComposeJobInput => ({
		compose: {
			id: "c1",
			organizationId: "org1",
			projectId: "p1",
			environmentId: "e1",
			name: "Shop",
			appName: "shop-abc",
			composeType: "docker-compose",
			sourceType: "git",
			composePath: "docker-compose.yml",
			command,
			createEnvFile: false,
			randomize: false,
			suffix: "",
			isolatedDeployment: false,
			isolatedDeploymentsVolume: false,
			pullImages: false,
		},
		composeFile: null,
		env: "",
		projectEnv: "",
		environmentEnv: "",
		domains: [],
		mounts: [],
		serviceNetworks: [],
		trusted,
	});
	const log = { line: () => {}, append: () => {} };

	test("untrusted deploys stop before anything runs", async () => {
		const { fake, commands } = host();
		await expect(
			deployCompose(fake, input(false), { source: { type: "existing" } }, log),
		).rejects.toThrow(/privileged/);
		expect(commands.some((c) => c.includes("compose -p"))).toBe(false);
	});

	test("instance admin deploys keep host-level settings and custom commands", async () => {
		const { fake, commands } = host();
		await deployCompose(
			fake,
			input(true, "run --rm -v /srv:/srv alpine true"),
			{ source: { type: "existing" } },
			log,
		);
		expect(commands.join("\n")).toContain("run --rm -v /srv:/srv alpine true");
	});
});

describe("untrusted jobs run only the checked resolved config", () => {
	const benign = "services:\n  a:\n    image: alpine\n";
	const fakeHost = (resolved: object, real: Record<string, string> = {}) => {
		const commands: string[] = [];
		const fake = {
			kind: "ssh",
			label: "fake",
			exec: async (command: string, options?: ExecOptions) => {
				commands.push(command, options?.input ?? "");
				if (command.includes("config --no-env-resolution --format json")) {
					return { code: 0, output: JSON.stringify(resolved) };
				}
				if (command.includes("realpath -m")) {
					const paths = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]);
					return {
						code: 0,
						output: paths.map((p) => `${real[p as string] ?? p}\0`).join(""),
					};
				}
				if (command.includes("readlink")) return { code: 0, output: benign };
				return { code: 0, output: "" };
			},
			run: async () => "",
			writeFile: async () => {},
			readFile: async () => null,
		} as unknown as Host;
		return { fake, commands };
	};
	const job = (
		overrides: Partial<ComposeJobInput["compose"]> = {},
	): ComposeJobInput => ({
		compose: {
			id: "c1",
			organizationId: "org1",
			projectId: "p1",
			environmentId: "e1",
			name: "Shop",
			appName: "shop-abc",
			composeType: "docker-compose",
			sourceType: "git",
			composePath: "docker-compose.yml",
			command: "",
			createEnvFile: false,
			randomize: false,
			suffix: "",
			isolatedDeployment: false,
			isolatedDeploymentsVolume: false,
			pullImages: false,
			...overrides,
		},
		composeFile: null,
		env: "SECRET=x",
		projectEnv: "",
		environmentEnv: "",
		domains: [],
		mounts: [],
		serviceNetworks: [],
		trusted: false,
	});
	const log = { line: () => {}, append: () => {} };
	const resolvedFile = "/etc/panara-cloud/compose-state/shop-abc/compose.json";
	const ran = (commands: string[]) =>
		commands.filter((c) => / up -d|stack deploy/.test(c));

	test("settings that only appear after include/extends/interpolation are refused", async () => {
		const { fake, commands } = fakeHost({
			services: { a: { image: "alpine", privileged: true } },
		});
		await expect(
			deployCompose(fake, job(), { source: { type: "existing" } }, log),
		).rejects.toThrow(/services\.a\.privileged/);
		expect(ran(commands)).toEqual([]);
	});

	test("a bind that resolves through a symlink to the host is refused", async () => {
		const source = `${base}/code/data`;
		const { fake, commands } = fakeHost(
			{
				services: {
					a: {
						image: "alpine",
						volumes: [{ type: "bind", source, target: "/d" }],
					},
				},
			},
			{ [source]: "/root" },
		);
		await expect(
			deployCompose(fake, job(), { source: { type: "existing" } }, log),
		).rejects.toThrow(/outside the service's directory/);
		expect(ran(commands)).toEqual([]);
	});

	test("compose.start re-checks the container-writable file", async () => {
		const { fake, commands } = fakeHost({
			services: { a: { image: "alpine", network_mode: "host" } },
		});
		await expect(startCompose(fake, job(), log)).rejects.toThrow(
			/network_mode/,
		);
		expect(ran(commands)).toEqual([]);
	});

	test("deploy and start run the resolved file under the service's project", async () => {
		for (const run of [
			(h: Host) =>
				deployCompose(h, job(), { source: { type: "existing" } }, log),
			(h: Host) => startCompose(h, job(), log),
		]) {
			const { fake, commands } = fakeHost({
				services: { a: { image: "alpine" } },
			});
			await run(fake);
			const [command] = ran(commands);
			expect(command).toContain(`compose -p shop-abc -f ${resolvedFile} up -d`);
		}
	});

	test("custom commands are bound to the service's own project and file", async () => {
		const { fake, commands } = fakeHost({
			services: { a: { image: "alpine" } },
		});
		await deployCompose(
			fake,
			job({ command: "compose --profile web up -d --build" }),
			{ source: { type: "existing" } },
			log,
		);
		expect(ran(commands)[0]).toContain(
			`compose -p shop-abc -f ${resolvedFile} --profile web up -d --build`,
		);
		for (const command of [
			"compose -p other-app down -v",
			"compose up -d && docker compose --project-name other down",
			"compose -f docker-compose.yml -f extra.yml up -d",
			"compose --env-file x.env up -d",
		]) {
			const { fake: other, commands: otherCommands } = fakeHost({
				services: { a: { image: "alpine" } },
			});
			await expect(
				deployCompose(
					other,
					job({ command }),
					{ source: { type: "existing" } },
					log,
				),
				command,
			).rejects.toThrow(/instance administrator/);
			expect(ran(otherCommands)).toEqual([]);
		}
	});

	test("untrusted stacks never source a file from the service directory", async () => {
		const { fake, commands } = fakeHost({
			services: { a: { image: "alpine" } },
		});
		await deployCompose(
			fake,
			job({ composeType: "stack" }),
			{ source: { type: "existing" } },
			log,
		);
		const all = commands.join("\n");
		expect(all).not.toMatch(/\. '\/etc\/panara-cloud\/compose\/shop-abc/);
		expect(all).not.toContain("set -a");
		expect(ran(commands)[0]).toContain(
			`stack deploy -c ${resolvedFile} shop-abc`,
		);
		await expect(
			deployCompose(
				fake,
				job({ composeType: "stack", command: "stack deploy -c x.yml other" }),
				{ source: { type: "existing" } },
				log,
			),
		).rejects.toThrow(/instance administrator/);
	});
});
