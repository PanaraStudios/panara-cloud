import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Host } from "../host/types";
import {
	checkForUpdate,
	compareSemver,
	detectPublicIp,
	listRegistryTags,
	migrateScript,
	type PanelConfig,
	parsePanelImages,
	parseRepository,
	parseVersionFeed,
	pickLatestTag,
	readPanelConfig,
	readPanelStatus,
	recoveryCommand,
	reloadPanel,
	setPanelPort,
	updatePanel,
} from "./panel";
import { isOfficialTraefikImage } from "./traefik/container";

const notFound = () =>
	Object.assign(new Error("not found"), { statusCode: 404 });

type FakeService = { image: string; ports?: number[] };
type FakeContainer = { image: string; ports?: number[]; running?: boolean };

const DIGEST = `sha256:${"ab".repeat(32)}`;
const PINNED = `\\@sha256\\:${"ab".repeat(32)}`;

const fakeHost = (
	resources: {
		services?: Record<string, FakeService>;
		containers?: Record<string, FakeContainer>;
	},
	exec: (command: string) => { code: number; output: string } = (command) => ({
		code: 0,
		output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
	}),
) => {
	const commands: string[] = [];
	const docker = {
		getService: (name: string) => ({
			inspect: async () => {
				const service = resources.services?.[name];
				if (!service) throw notFound();
				return {
					Spec: {
						TaskTemplate: { ContainerSpec: { Image: service.image } },
						EndpointSpec: {
							Ports: (service.ports ?? []).map((port) => ({
								TargetPort: port,
								PublishedPort: port,
							})),
						},
					},
				};
			},
		}),
		getContainer: (name: string) => ({
			inspect: async () => {
				const container = resources.containers?.[name];
				if (!container) throw notFound();
				return {
					Config: { Image: container.image },
					State: { Running: container.running ?? true },
					HostConfig: {
						PortBindings: Object.fromEntries(
							(container.ports ?? []).map((port) => [
								`${port}/tcp`,
								[{ HostPort: String(port) }],
							]),
						),
					},
				};
			},
		}),
		listTasks: async () => [{ Status: { State: "running" } }],
	};
	const host = {
		kind: "local",
		label: "test",
		docker: () => docker,
		exec: async (command: string) => {
			commands.push(command);
			return exec(command);
		},
		run: async (command: string) => {
			commands.push(command);
			return "";
		},
		writeFile: async () => {},
		readFile: async () => null,
		close: () => {},
	} as unknown as Host;
	return { host, commands };
};

const config = (fields: Partial<PanelConfig> = {}): PanelConfig => ({
	version: "1.2.0",
	releaseTag: "latest",
	services: [
		{ name: "panara-cloud-web", repository: "ghcr.io/acme/panara-cloud-web" },
		{
			name: "panara-cloud-agent",
			repository: "ghcr.io/acme/panara-cloud-agent",
		},
	],
	webService: "panara-cloud-web",
	panelPort: 3000,
	versionUrl: null,
	agentService: null,
	agentStopGraceSeconds: 660,
	migrator: null,
	...fields,
});

const bashSyntaxOk = (script: string) =>
	spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status === 0;

describe("panel config", () => {
	test("parses service=repository pairs and drops tags", () => {
		expect(
			parsePanelImages(
				"panara-cloud-web=ghcr.io/acme/web:1.0, panara-cloud-agent=registry:5000/agent",
			),
		).toEqual([
			{ name: "panara-cloud-web", repository: "ghcr.io/acme/web" },
			{ name: "panara-cloud-agent", repository: "registry:5000/agent" },
		]);
		expect(parsePanelImages(undefined)).toEqual([]);
		expect(() => parsePanelImages("web")).toThrow(/service=repository/);
		expect(() => parsePanelImages("web=bad repo;rm")).toThrow();
		expect(() => parsePanelImages("we$b=repo")).toThrow();
	});

	test("reads defaults from the environment", () => {
		const parsed = readPanelConfig({
			PANARA_CLOUD_IMAGES: "panara-cloud-web=acme/web",
			PANARA_CLOUD_VERSION: "2.0.0",
		});
		expect(parsed).toMatchObject({
			version: "2.0.0",
			releaseTag: "latest",
			webService: "panara-cloud-web",
			panelPort: 3000,
			versionUrl: null,
		});
		expect(readPanelConfig({}).version).toMatch(/^\d+\.\d+\.\d+/);
		expect(() =>
			readPanelConfig({ PANARA_CLOUD_RELEASE_TAG: "x; rm -rf /" }),
		).toThrow();
		expect(() => readPanelConfig({ PANARA_CLOUD_PANEL_PORT: "0" })).toThrow();
	});
});

describe("versions", () => {
	test("semver comparison and latest tag", () => {
		expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
		expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
		expect(
			pickLatestTag(["latest", "1.2.0", "v1.10.1", "1.9.0", "canary"]),
		).toBe("v1.10.1");
		expect(pickLatestTag(["latest"])).toBeNull();
	});

	test("version feeds", () => {
		expect(parseVersionFeed('{"version":"1.3.0"}')).toBe("1.3.0");
		expect(parseVersionFeed('{"tag_name":"v1.3.0"}')).toBe("v1.3.0");
		expect(parseVersionFeed("1.4.0\n")).toBe("1.4.0");
		expect(parseVersionFeed("")).toBeNull();
	});

	test("repositories map to registry API names", () => {
		expect(parseRepository("traefik")).toEqual({
			registry: "registry-1.docker.io",
			name: "library/traefik",
		});
		expect(parseRepository("acme/web")).toEqual({
			registry: "registry-1.docker.io",
			name: "acme/web",
		});
		expect(parseRepository("ghcr.io/acme/web")).toEqual({
			registry: "ghcr.io",
			name: "acme/web",
		});
		expect(parseRepository("localhost:5000/web")).toEqual({
			registry: "localhost:5000",
			name: "web",
		});
	});

	test("lists tags through an anonymous bearer token", async () => {
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://ghcr.io/token")) {
				expect(url).toContain("scope=repository%3Aacme%2Fweb%3Apull");
				return Response.json({ token: "t" });
			}
			const auth = (init?.headers as Record<string, string> | undefined)
				?.Authorization;
			if (!auth) {
				return new Response("", {
					status: 401,
					headers: {
						"www-authenticate":
							'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/web:pull"',
					},
				});
			}
			expect(auth).toBe("Bearer t");
			return Response.json({ tags: ["1.0.0", "1.1.0"] });
		});
		await expect(
			listRegistryTags("ghcr.io/acme/web", fetchFn as unknown as typeof fetch),
		).resolves.toEqual(["1.0.0", "1.1.0"]);
	});

	test("update check against the registry and a version URL", async () => {
		const { host } = fakeHost({});
		const registry = (async () =>
			Response.json({ tags: ["1.1.0", "1.3.0", "latest"] })) as typeof fetch;
		await expect(checkForUpdate(host, config(), registry)).resolves.toEqual({
			currentVersion: "1.2.0",
			releaseTag: "latest",
			latestVersion: "1.3.0",
			updateAvailable: true,
		});
		const feed = (async () => new Response("1.2.0")) as typeof fetch;
		await expect(
			checkForUpdate(
				host,
				config({ versionUrl: "https://example.test/v" }),
				feed,
			),
		).resolves.toMatchObject({
			latestVersion: "1.2.0",
			updateAvailable: false,
		});
		const hostile = (async () =>
			new Response("1.3.0; rm -rf /")) as typeof fetch;
		await expect(
			checkForUpdate(
				host,
				config({ versionUrl: "https://example.test/v" }),
				hostile,
			),
		).rejects.toThrow(/Unexpected version/);
	});

	test("moving channels compare digests", async () => {
		const { host } = fakeHost({
			services: {
				"panara-cloud-web": {
					image: "ghcr.io/acme/panara-cloud-web:canary@sha256:old",
				},
			},
		});
		const fetchFn = (async () =>
			new Response(null, {
				headers: { "docker-content-digest": "sha256:new" },
			})) as typeof fetch;
		await expect(
			checkForUpdate(host, config({ releaseTag: "canary" }), fetchFn),
		).resolves.toMatchObject({
			latestVersion: "canary",
			updateAvailable: true,
		});
	});

	test("no services configured", async () => {
		const { host } = fakeHost({});
		await expect(
			checkForUpdate(host, config({ services: [] })),
		).rejects.toThrow(/PANARA_CLOUD_IMAGES/);
	});
});

describe("panel operations", () => {
	test("status reports services and the panel port", async () => {
		const { host } = fakeHost({
			services: {
				"panara-cloud-web": {
					image: "ghcr.io/acme/panara-cloud-web:1.2.0",
					ports: [3000],
				},
			},
			containers: {
				"panara-cloud-agent": {
					image: "ghcr.io/acme/panara-cloud-agent:1.2.0",
				},
			},
		});
		const status = await readPanelStatus(host, config());
		expect(status).toMatchObject({
			version: "1.2.0",
			webServiceKind: "service",
			panelPortPublished: true,
		});
		expect(status.services.map((s) => [s.name, s.kind, s.running])).toEqual([
			["panara-cloud-web", "service", true],
			["panara-cloud-agent", "container", true],
		]);
	});

	test("reload restarts services and schedules container restarts", async () => {
		const { host, commands } = fakeHost({
			services: { "panara-cloud-web": { image: "web" } },
			containers: { "panara-cloud-agent": { image: "agent" } },
		});
		await reloadPanel(host, config(), () => {});
		const script = commands.join("\n");
		expect(script).toContain(
			"$DOCKER service update --detach --force panara-cloud-web",
		);
		expect(script).toContain(
			'nohup bash -c "sleep 3; $DOCKER restart panara-cloud-agent"',
		);
		for (const command of commands) expect(bashSyntaxOk(command)).toBe(true);
	});

	test("update pulls then updates every service, agent last", async () => {
		const { host, commands } = fakeHost({
			services: {
				"panara-cloud-web": { image: "web" },
				"panara-cloud-agent": { image: "agent" },
			},
		});
		const registry = (async () =>
			Response.json({ tags: ["1.3.0"] })) as typeof fetch;
		const result = await updatePanel(host, config(), () => {}, registry);
		expect(result.latestVersion).toBe("1.3.0");
		const updates = commands.filter((c) => c.includes("service update"));
		expect(updates.map((c) => c.split("\n").at(-1))).toEqual([
			`$DOCKER service update --detach --with-registry-auth --image ghcr.io/acme/panara-cloud-web\\:1.3.0${PINNED} panara-cloud-web`,
			`$DOCKER service update --detach --with-registry-auth --image ghcr.io/acme/panara-cloud-agent\\:1.3.0${PINNED} panara-cloud-agent`,
		]);
		expect(commands.findIndex((c) => c.includes("pull"))).toBeLessThan(
			commands.findIndex((c) => c.includes("service update")),
		);
	});

	test("update gives the agent's service a grace period covering its drain", async () => {
		const { host, commands } = fakeHost({
			services: {
				"panara-cloud-web": { image: "web" },
				"panara-cloud-agent": { image: "agent" },
			},
		});
		const registry = (async () =>
			Response.json({ tags: ["1.3.0"] })) as typeof fetch;
		const fromEnv = readPanelConfig({
			PANARA_CLOUD_IMAGES:
				"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
			PANARA_CLOUD_AGENT_SERVICE: "panara-cloud-agent",
			AGENT_DRAIN_TIMEOUT_SECONDS: "300",
		});
		expect(fromEnv).toMatchObject({
			agentService: "panara-cloud-agent",
			agentStopGraceSeconds: 360,
		});
		await updatePanel(host, fromEnv, () => {}, registry);
		const updates = commands
			.filter((c) => c.includes("service update"))
			.map((c) => c.split("\n").at(-1));
		expect(updates).toEqual([
			`$DOCKER service update --detach --with-registry-auth --image ghcr.io/acme/panara-cloud-web\\:1.3.0${PINNED} panara-cloud-web`,
			`$DOCKER service update --detach --with-registry-auth --stop-grace-period 360s --image ghcr.io/acme/panara-cloud-agent\\:1.3.0${PINNED} panara-cloud-agent`,
		]);
		expect(
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "a=acme/a",
				PANARA_CLOUD_MIGRATOR: "a",
			}),
		).toMatchObject({ agentService: "a", agentStopGraceSeconds: 660 });
	});

	test("update deploys functions with the new agent image before rolling", async () => {
		const { host, commands } = fakeHost({
			services: {
				"panara-cloud-web": { image: "web" },
				"panara-cloud-agent": { image: "agent" },
			},
		});
		const registry = (async () =>
			Response.json({ tags: ["1.3.0"] })) as typeof fetch;
		const migrator = readPanelConfig({
			PANARA_CLOUD_IMAGES:
				"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
			PANARA_CLOUD_MIGRATOR: "panara-cloud-agent",
			PANARA_CLOUD_CONVEX_SELF_HOSTED_URL: "http://panara-cloud-convex:3210",
			PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE:
				"/etc/panara-cloud/secrets/convex-admin-key",
		}).migrator;
		await updatePanel(host, config({ migrator }), () => {}, registry);
		const migrate = commands.findIndex((c) => c.includes(" migrate"));
		expect(migrate).toBeGreaterThan(
			commands.findIndex((c) => c.includes("pull")),
		);
		expect(migrate).toBeLessThan(
			commands.findIndex((c) => c.includes("service update")),
		);
		const script = commands[migrate] ?? "";
		expect(script.split("\n").at(-1)).toBe(
			`$DOCKER run --rm --network panara-cloud-network -e CONVEX_SELF_HOSTED_URL=http\\://panara-cloud-convex\\:3210 -v /etc/panara-cloud/secrets/convex-admin-key\\:/run/panara-cloud/convex-admin-key\\:ro -e CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=/run/panara-cloud/convex-admin-key ghcr.io/acme/panara-cloud-agent\\:1.3.0${PINNED} migrate`,
		);
		expect(bashSyntaxOk(script)).toBe(true);
	});

	test("the installer runs the migrator and panel setup by the image ID it just pulled", () => {
		const installSh = readFileSync(
			new URL("../../../../deploy/install.sh", import.meta.url),
			"utf8",
		);
		const runs = installSh
			.split("\n")
			.filter((line) => /"\$@" "\$[A-Z_]+" (migrate|panel-setup)\b/.test(line));
		expect(runs).toHaveLength(2);
		for (const line of runs) expect(line).toContain('"$AGENT_RUN_REF"');
		expect(installSh).toMatch(
			/pull "\$AGENT_REF"\n(\t#[^\n]*\n)*\tAGENT_RUN_REF=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$AGENT_REF"\)/,
		);
	});

	test("update refuses to continue when the pull reports no digest", async () => {
		const { host, commands } = fakeHost(
			{
				services: {
					"panara-cloud-web": { image: "web" },
					"panara-cloud-agent": { image: "agent" },
				},
			},
			() => ({ code: 0, output: "" }),
		);
		const registry = (async () =>
			Response.json({ tags: ["1.3.0"] })) as typeof fetch;
		await expect(
			updatePanel(host, config(), () => {}, registry),
		).rejects.toThrow(/did not report a digest/);
		expect(commands.some((c) => c.includes("service update"))).toBe(false);
	});

	test("the migrator must be a panel service and needs an admin key", () => {
		expect(() =>
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "panara-cloud-web=acme/web",
				PANARA_CLOUD_MIGRATOR: "other",
			}),
		).toThrow(/not one of the PANARA_CLOUD_IMAGES/);
		expect(() =>
			migrateScript(
				{
					service: "panara-cloud-agent",
					convexUrl: null,
					adminKeyFile: null,
					inlineAdminKey: false,
				},
				"acme/agent:1.0.0",
			),
		).toThrow(/ADMIN_KEY/);
		expect(
			migrateScript(
				{
					service: "panara-cloud-agent",
					convexUrl: null,
					adminKeyFile: null,
					inlineAdminKey: true,
				},
				"acme/agent:1.0.0",
			),
		).toContain(
			'CONVEX_SELF_HOSTED_ADMIN_KEY="$PANARA_CLOUD_CONVEX_ADMIN_KEY"',
		);
	});

	test("update refuses containers", async () => {
		const { host } = fakeHost({
			services: { "panara-cloud-web": { image: "web" } },
			containers: { "panara-cloud-agent": { image: "agent" } },
		});
		const registry = (async () =>
			Response.json({ tags: ["1.3.0"] })) as typeof fetch;
		await expect(
			updatePanel(host, config(), () => {}, registry),
		).rejects.toThrow(/not running as a Docker Swarm service/);
	});

	test("port 3000 toggle", async () => {
		const { host, commands } = fakeHost({
			services: { "panara-cloud-web": { image: "web", ports: [3000] } },
		});
		await setPanelPort(host, config(), false);
		expect(commands.at(-1)).toContain(
			"--publish-rm published=3000,target=3000,mode=host --publish-rm published=3000,target=3000,mode=ingress panara-cloud-web",
		);
		await setPanelPort(host, config(), true);
		expect(commands.at(-1)).toContain(
			"--publish-add published=3000,target=3000,mode=host panara-cloud-web",
		);
		expect(recoveryCommand(config())).toBe(
			"docker service update --publish-add published=3000,target=3000,mode=host panara-cloud-web",
		);
		const { host: containerHost } = fakeHost({
			containers: { "panara-cloud-web": { image: "web" } },
		});
		await expect(setPanelPort(containerHost, config(), true)).rejects.toThrow(
			/not running as a Docker Swarm service/,
		);
	});

	test("public IP falls back across sources and rejects junk", async () => {
		let calls = 0;
		const { host } = fakeHost({}, () => {
			calls++;
			return calls === 1
				? { code: 0, output: "<html>blocked</html>" }
				: { code: 0, output: "203.0.113.7\n" };
		});
		await expect(detectPublicIp(host)).resolves.toBe("203.0.113.7");
		const { host: offline } = fakeHost({}, () => ({ code: 7, output: "" }));
		await expect(detectPublicIp(offline)).resolves.toBeNull();
	});
});

describe("traefik image", () => {
	test("only the official image counts as managed", () => {
		expect(isOfficialTraefikImage("traefik:v3.6.7")).toBe(true);
		expect(
			isOfficialTraefikImage("docker.io/library/traefik:3.1@sha256:abc"),
		).toBe(true);
		expect(isOfficialTraefikImage("ghcr.io/acme/traefik:v3.6.7")).toBe(false);
		expect(isOfficialTraefikImage("acme/traefik-plugins:1")).toBe(false);
	});
});
