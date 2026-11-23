import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Host } from "../host/types";
import { CONVEX_SETTINGS } from "./convexSettings";
import {
	CONVEX_IMAGES_BEFORE_0_1_6,
	checkForUpdate,
	compareSemver,
	convexFollowsReleases,
	describeMemory,
	detectPublicIp,
	ensureConvexEnvironment,
	listRegistryTags,
	migrateFailure,
	migrateScript,
	type PanelConfig,
	parseMeminfo,
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
import { failureReason } from "./shell";
import { isOfficialTraefikImage } from "./traefik/container";

const notFound = () =>
	Object.assign(new Error("not found"), { statusCode: 404 });

type FakeService = { image: string; ports?: number[]; env?: string[] };
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
						TaskTemplate: {
							ContainerSpec: { Image: service.image, Env: service.env },
						},
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
	convexService: "panara-cloud-convex",
	convexRepository: null,
	updateMinFreeMb: 1000,
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

	test("update deploys functions with the migrate image of the new agent before rolling, then removes it", async () => {
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
			`$DOCKER run --rm --oom-score-adj 1000 --network panara-cloud-network -e CONVEX_SELF_HOSTED_URL=http\\://panara-cloud-convex\\:3210 -v /etc/panara-cloud/secrets/convex-admin-key\\:/run/panara-cloud/convex-admin-key\\:ro -e CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=/run/panara-cloud/convex-admin-key ghcr.io/acme/panara-cloud-migrate\\:1.3.0${PINNED} migrate`,
		);
		expect(bashSyntaxOk(script)).toBe(true);
		const lastLines = commands.map((c) => c.split("\n").at(-1) ?? "");
		expect(lastLines.filter((line) => line.includes("pull"))).toEqual([
			"$DOCKER pull ghcr.io/acme/panara-cloud-web\\:1.3.0",
			"$DOCKER pull ghcr.io/acme/panara-cloud-agent\\:1.3.0",
			"$DOCKER pull ghcr.io/acme/panara-cloud-migrate\\:1.3.0",
		]);
		const removed = lastLines.findIndex((line) =>
			line.startsWith(
				"$DOCKER image rm ghcr.io/acme/panara-cloud-migrate\\:1.3.0",
			),
		);
		expect(removed).toBeGreaterThan(migrate);
		expect(removed).toBeLessThan(
			commands.findIndex((c) => c.includes("service update")),
		);
	});

	test("the migrate image follows the new agent's version label and its own repository setting", async () => {
		const { host, commands } = fakeHost(
			{
				services: {
					"panara-cloud-web": { image: "web" },
					"panara-cloud-agent": { image: "agent" },
				},
			},
			(command) => ({
				code: 0,
				output: command.includes("pull")
					? `Digest: ${DIGEST}\n`
					: command.includes("image inspect")
						? "1.3.0-canary.abc1234\n"
						: "",
			}),
		);
		const fromEnv = readPanelConfig({
			PANARA_CLOUD_IMAGES:
				"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
			PANARA_CLOUD_MIGRATOR: "panara-cloud-agent",
			PANARA_CLOUD_MIGRATE_IMAGE: "mirror.example/panara/migrate:ignored",
			PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE: "/etc/panara-cloud/secrets/key",
		});
		expect(fromEnv.migrator?.image).toBe("mirror.example/panara/migrate");
		await updatePanel(
			host,
			config({ migrator: fromEnv.migrator }),
			() => {},
			registry,
		);
		const lastLines = commands.map((c) => c.split("\n").at(-1) ?? "");
		expect(lastLines).toContain(
			"$DOCKER pull mirror.example/panara/migrate\\:1.3.0-canary.abc1234",
		);
		expect(lastLines.find((line) => line.endsWith(" migrate"))).toContain(
			`mirror.example/panara/migrate\\:1.3.0-canary.abc1234${PINNED} migrate`,
		);
		expect(() =>
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "a=acme/agent",
				PANARA_CLOUD_MIGRATOR: "a",
				PANARA_CLOUD_MIGRATE_IMAGE: "acme/migrate@sha256:00",
			}),
		).toThrow(/Invalid PANARA_CLOUD_MIGRATE_IMAGE/);
		expect(
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "a=acme/other",
				PANARA_CLOUD_MIGRATOR: "a",
			}).migrator?.image,
		).toBe("ghcr.io/panarastudios/panara-cloud-migrate");
	});

	test("a migrate image that can't be pulled stops the update before anything changes", async () => {
		const { host, commands } = fakeHost(
			{
				services: {
					"panara-cloud-web": { image: "web" },
					"panara-cloud-agent": { image: "agent" },
				},
			},
			(command) =>
				command.includes("pull") && command.includes("migrate")
					? { code: 1, output: "manifest unknown\n" }
					: {
							code: 0,
							output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
						},
		);
		await expect(
			updatePanel(host, withMigrator(), () => {}, registry),
		).rejects.toThrow("manifest unknown");
		expect(commands.some((c) => c.endsWith(" migrate"))).toBe(false);
		expect(commands.some((c) => c.includes("service update"))).toBe(false);
	});

	const convexUpdates = (commands: string[]) =>
		commands
			.map((c) => c.split("\n").at(-1) ?? "")
			.filter((line) => line.endsWith(" panara-cloud-convex"));

	const panelServices = {
		"panara-cloud-web": { image: "web" },
		"panara-cloud-agent": { image: "agent" },
	};

	const completeConvexEnv = [
		"INSTANCE_NAME=panara-cloud",
		...CONVEX_SETTINGS.map((setting) => `${setting.name}=${setting.value}`),
	];

	const withMigrator = () =>
		config({
			migrator: readPanelConfig({
				PANARA_CLOUD_IMAGES:
					"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
				PANARA_CLOUD_MIGRATOR: "panara-cloud-agent",
				PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE: "/etc/panara-cloud/secrets/key",
			}).migrator,
		});

	const registry = (async () =>
		Response.json({ tags: ["1.3.0"] })) as typeof fetch;

	test("update restarts Convex once, after migrate and before the services roll", async () => {
		const { host, commands } = fakeHost({
			services: {
				...panelServices,
				"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
			},
		});
		const lines: string[] = [];
		await updatePanel(
			host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		expect(convexUpdates(commands)).toEqual([
			"timeout 240 $DOCKER service update --quiet --detach=false --update-order stop-first --force panara-cloud-convex",
		]);
		const restart = commands.findIndex((c) =>
			c.endsWith(" panara-cloud-convex"),
		);
		expect(restart).toBeGreaterThan(
			commands.findIndex((c) => c.includes(" migrate")),
		);
		expect(restart).toBeLessThan(
			commands.findIndex((c) => c.includes("--image")),
		);
		expect(lines).toContain(
			"Restarting panara-cloud-convex to release the memory the functions deploy used",
		);
		for (const command of commands) expect(bashSyntaxOk(command)).toBe(true);
	});

	test("update adds the Convex settings an older install lacks, in the same restart", async () => {
		const { host, commands } = fakeHost({
			services: {
				...panelServices,
				"panara-cloud-convex": {
					image: "convex",
					env: [
						"INSTANCE_NAME=panara-cloud",
						"DISABLE_METRICS_ENDPOINT=true",
						"MALLOC_ARENA_MAX=8",
						"DISABLE_BEACON=",
						"REDACT_LOGS_TO_CLIENT=",
					],
				},
			},
		});
		const lines: string[] = [];
		await updatePanel(
			host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		const [update, ...others] = convexUpdates(commands);
		expect(others).toEqual([]);
		expect(update).toMatch(
			/^timeout 240 \$DOCKER service update --quiet --detach=false --update-order stop-first --force --env-add /,
		);
		const added = [...(update ?? "").matchAll(/--env-add (\S+)/g)].map(
			(match) => match[1]?.replaceAll("\\", ""),
		);
		expect(added).toEqual(
			CONVEX_SETTINGS.filter(
				(setting) =>
					setting.name !== "MALLOC_ARENA_MAX" &&
					setting.name !== "DISABLE_BEACON",
			).map((setting) => `${setting.name}=${setting.value}`),
		);
		expect(added).toContain("REDACT_LOGS_TO_CLIENT=true");
		expect(lines.join("\n")).toMatch(
			/Adding REDACT_LOGS_TO_CLIENT, DOCUMENT_RETENTION_DELAY, .* to panara-cloud-convex; Convex restarts once/,
		);
	});

	test("a Convex restart that fails is reported and the update still rolls the services", async () => {
		const { host, commands } = fakeHost(
			{
				services: {
					...panelServices,
					"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
				},
			},
			(command) =>
				command.endsWith(" panara-cloud-convex")
					? { code: 1, output: "update paused due to failure\n" }
					: {
							code: 0,
							output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
						},
		);
		const lines: string[] = [];
		const result = await updatePanel(
			host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		expect(result.latestVersion).toBe("1.3.0");
		expect(lines).toContain(
			"⚠️ panara-cloud-convex was not restarted (update paused due to failure); the update continues. To do it by hand: docker service update --force panara-cloud-convex",
		);
		expect(
			commands
				.filter((c) => c.includes("--image"))
				.map((c) => c.split(" ").at(-1)),
		).toEqual(["panara-cloud-web", "panara-cloud-agent"]);
	});

	test("a failed migrate stops the update before Convex is restarted or anything rolls", async () => {
		const { host, commands } = fakeHost(
			{
				services: {
					...panelServices,
					"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
				},
			},
			(command) =>
				command.includes(" migrate")
					? { code: 1, output: "push failed\n" }
					: {
							code: 0,
							output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
						},
		);
		await expect(
			updatePanel(host, withMigrator(), () => {}, registry),
		).rejects.toThrow("push failed");
		expect(commands.some((c) => c.includes("service update"))).toBe(false);
	});

	test("a failed migrate fails the update with its reason, not Node's banner", async () => {
		const NODE_CRASH = [
			"[migrate] Deploying functions",
			"✖ Error: Unable to push deployment config to http://panara-cloud-convex:3210",
			"file:///app/scripts/convex-cli.mjs:30",
			'\t\tthrow new Error(`convex ${args.slice(0, 2).join(" ")} failed`);',
			"\t\t      ^",
			"",
			"Error: convex deploy --typecheck failed",
			"    at convex (file:///app/scripts/convex-cli.mjs:30:9)",
			"    at deploy (file:///app/scripts/install.mjs:119:2)",
			"",
			"Node.js v24.22.1",
			"",
		].join("\n");
		expect(failureReason(NODE_CRASH)).toBe(
			"Error: convex deploy --typecheck failed",
		);
		expect(failureReason("one\ntwo\n\n")).toBe("two");
		expect(failureReason("\n\n")).toBe(null);

		expect(migrateFailure(1, NODE_CRASH)).toBe(
			"Error: convex deploy --typecheck failed. No service was changed, and pressing Update again is safe.",
		);
		expect(
			migrateFailure(
				1,
				"[migrate] Deploying functions\n[migrate] Deploying the functions failed: ✖ Schema validation failed\n",
			),
		).toBe(
			"Deploying the functions failed: ✖ Schema validation failed. No service was changed, and pressing Update again is safe.",
		);
		for (const [code, output] of [
			[137, ""],
			[null, ""],
			[
				1,
				"[migrate] Deploying the functions was killed: the server ran out of memory while they were bundled and pushed\n",
			],
		] as const) {
			const message = migrateFailure(code, output);
			expect(message).toContain("the server ran out of memory");
			expect(message).toContain("No service was changed");
			expect(message).toContain("press Update again");
		}
		const afterPush = migrateFailure(
			1,
			"[migrate] Deploying functions\n[migrate] install:migrate failed ([Request ID: 1] Server Error); trying again\n[migrate] The functions are deployed, but install:migrate failed after 6 attempts: [Request ID: 2] Server Error\n",
		);
		expect(afterPush).toContain(
			"The functions are deployed, but install:migrate failed",
		);
		expect(afterPush).toContain("press Update again to finish the update");
		expect(afterPush).not.toContain("No service was changed");
		expect(migrateFailure(2, "")).toBe(
			"The functions deploy exited with status 2. No service was changed, and pressing Update again is safe.",
		);

		const { host, commands } = fakeHost(
			{
				services: {
					...panelServices,
					"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
				},
			},
			(command) =>
				command.includes(" migrate")
					? { code: 1, output: NODE_CRASH }
					: {
							code: 0,
							output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
						},
		);
		await expect(
			updatePanel(host, withMigrator(), () => {}, registry),
		).rejects.toThrow(
			"Error: convex deploy --typecheck failed. No service was changed, and pressing Update again is safe.",
		);
		expect(commands.some((c) => c.includes("--image"))).toBe(false);
	});

	test("the migrate script's own failure line skips the same noise", async () => {
		const { failureLine } = (await import(
			new URL(
				"../../../../packages/backend/scripts/failure.mjs",
				import.meta.url,
			).href
		)) as { failureLine: (output: string) => string | null };
		expect(
			failureLine(
				"- Deploying...\n✖ Error: Unable to push deployment config\nError fetching POST http://x 500: Hit an error while pushing: schema validation failed\n\n",
			),
		).toBe(
			"Error fetching POST http://x 500: Hit an error while pushing: schema validation failed",
		);
		expect(
			failureLine("    at x (file:///a.mjs:1:1)\n\nNode.js v24.22.1\n"),
		).toBe(null);
		expect(failureLine("uploading\ndone 12 files\n")).toBe("done 12 files");
		// Killed mid-deploy, the CLI's last words are its progress line.
		expect(
			failureLine(
				"▌ Deploying code to deployment:\n▌ └─ http://convex:3210\n- Deploying to http://convex:3210...\n\n",
			),
		).toBe(null);
	});

	const meminfo = (availableMb: number, swapFreeMb = 0) =>
		`MemTotal:        2014212 kB\nMemFree:          102400 kB\nMemAvailable:   ${availableMb * 1024} kB\nSwapTotal:      ${swapFreeMb * 1024} kB\nSwapFree:       ${swapFreeMb * 1024} kB\n`;

	// A host whose /proc/meminfo answers with each of `readings` in turn (the
	// last one from then on).
	const hostWithMemory = (readings: string[]) => {
		let read = 0;
		return fakeHost(
			{
				services: {
					...panelServices,
					"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
				},
			},
			(command) => {
				if (command === "cat /proc/meminfo") {
					const output = readings[Math.min(read, readings.length - 1)] ?? "";
					read += 1;
					return { code: 0, output };
				}
				return {
					code: 0,
					output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
				};
			},
		);
	};

	const order = (commands: string[]) =>
		commands
			.map((command) => command.split("\n").at(-1) ?? "")
			.map((line) =>
				line.endsWith(" migrate")
					? "migrate"
					: line.endsWith(" panara-cloud-convex")
						? "restart convex"
						: line.includes("--image")
							? `roll ${line.split(" ").at(-1)}`
							: null,
			)
			.filter(Boolean);

	test("host memory is read from /proc/meminfo", () => {
		expect(parseMeminfo(meminfo(1234, 2047))).toEqual({
			availableMb: 1234,
			swapFreeMb: 2047,
		});
		expect(parseMeminfo("MemAvailable:    512000 kB\n")).toEqual({
			availableMb: 500,
			swapFreeMb: 0,
		});
		expect(parseMeminfo("")).toBe(null);
		expect(describeMemory({ availableMb: 640, swapFreeMb: 0 })).toBe(
			"640 MB free (640 MB of memory available, no swap)",
		);
		expect(describeMemory({ availableMb: 640, swapFreeMb: 2000 })).toBe(
			"2640 MB free (640 MB of memory available, 2000 MB of swap)",
		);
	});

	test("with memory to spare, Convex restarts once, after the functions deploy", async () => {
		const { host, commands } = hostWithMemory([meminfo(5200)]);
		const lines: string[] = [];
		await updatePanel(
			host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		expect(order(commands)).toEqual([
			"migrate",
			"restart convex",
			"roll panara-cloud-web",
			"roll panara-cloud-agent",
		]);
		expect(lines.join("\n")).not.toContain("MB free");
	});

	test("short of memory, Convex restarts before the functions deploy as well", async () => {
		const { host, commands } = hostWithMemory([meminfo(780), meminfo(1150)]);
		const lines: string[] = [];
		await updatePanel(
			host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		expect(order(commands)).toEqual([
			"restart convex",
			"migrate",
			"restart convex",
			"roll panara-cloud-web",
			"roll panara-cloud-agent",
		]);
		expect(lines).toContain(
			"780 MB free (780 MB of memory available, no swap): short for the functions deploy",
		);
		expect(lines).toContain(
			"Restarting panara-cloud-convex to make room for the functions deploy",
		);
		expect(lines).toContain(
			"⚠️ 1150 MB free (1150 MB of memory available, no swap): just enough for the functions deploy. The server may be slow for a minute.",
		);
		expect(lines).toContain(
			"Restarting panara-cloud-convex to release the memory the functions deploy used",
		);
	});

	test("swap counts as room", async () => {
		const { host, commands } = hostWithMemory([meminfo(400, 2047)]);
		await updatePanel(host, withMigrator(), () => {}, registry);
		expect(order(commands)).toEqual([
			"migrate",
			"restart convex",
			"roll panara-cloud-web",
			"roll panara-cloud-agent",
		]);
	});

	test("without room even after restarting Convex, the update refuses with the numbers and changes nothing", async () => {
		const { host, commands } = hostWithMemory([meminfo(310), meminfo(640)]);
		const lines: string[] = [];
		await expect(
			updatePanel(host, withMigrator(), (line) => lines.push(line), registry),
		).rejects.toThrow(
			'Not enough free memory to update: 640 MB free (640 MB of memory available, no swap), and deploying the new functions needs about 1000 MB on top of the running panel. Nothing was changed. Add swap or free some memory (docs/install.md, "Updating on a small server"), then press Update again.',
		);
		expect(order(commands)).toEqual(["restart convex"]);
		expect(lines).toContain(
			"310 MB free (310 MB of memory available, no swap): short for the functions deploy",
		);
	});

	test("the memory check can be turned off, and is skipped where memory can't be read", async () => {
		const off = hostWithMemory([meminfo(310)]);
		await updatePanel(
			off.host,
			{ ...withMigrator(), updateMinFreeMb: 0 },
			() => {},
			registry,
		);
		expect(order(off.commands)).toEqual([
			"migrate",
			"restart convex",
			"roll panara-cloud-web",
			"roll panara-cloud-agent",
		]);
		expect(off.commands).not.toContain("cat /proc/meminfo");

		const unreadable = hostWithMemory([""]);
		await updatePanel(unreadable.host, withMigrator(), () => {}, registry);
		expect(order(unreadable.commands)[0]).toBe("migrate");

		expect(
			readPanelConfig({ PANARA_CLOUD_UPDATE_MIN_FREE_MB: "0" }).updateMinFreeMb,
		).toBe(0);
		expect(readPanelConfig({}).updateMinFreeMb).toBe(1000);
		expect(() =>
			readPanelConfig({ PANARA_CLOUD_UPDATE_MIN_FREE_MB: "lots" }),
		).toThrow(/number of MB/);
	});

	test("Convex is left alone when it is not a Swarm service", async () => {
		const container = fakeHost({
			services: panelServices,
			containers: { "panara-cloud-convex": { image: "convex" } },
		});
		const warnings: string[] = [];
		await updatePanel(
			container.host,
			withMigrator(),
			(line) => warnings.push(line),
			registry,
		);
		expect(convexUpdates(container.commands)).toEqual([]);
		expect(warnings.join("\n")).toContain(
			"set REDACT_LOGS_TO_CLIENT=true on it",
		);

		const absent = fakeHost({ services: panelServices });
		const lines: string[] = [];
		await updatePanel(
			absent.host,
			withMigrator(),
			(line) => lines.push(line),
			registry,
		);
		expect(convexUpdates(absent.commands)).toEqual([]);
		expect(lines.join("\n")).not.toContain("panara-cloud-convex");
		expect(absent.commands.filter((c) => c.includes("--image"))).toHaveLength(
			2,
		);
	});

	test("without a functions deploy Convex restarts only to take missing settings", async () => {
		const complete = fakeHost({
			services: {
				...panelServices,
				"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
			},
		});
		await updatePanel(complete.host, config(), () => {}, registry);
		expect(convexUpdates(complete.commands)).toEqual([]);

		const old = fakeHost({
			services: {
				...panelServices,
				"panara-cloud-convex": {
					image: "convex",
					env: completeConvexEnv.filter(
						(entry) => !entry.startsWith("TMPDIR="),
					),
				},
			},
		});
		await updatePanel(old.host, config(), () => {}, registry);
		expect(convexUpdates(old.commands)).toEqual([
			"timeout 240 $DOCKER service update --quiet --detach=false --update-order stop-first --env-add TMPDIR\\=/tmp panara-cloud-convex",
		]);
	});

	test("a starting agent adds missing Convex settings and otherwise does nothing", async () => {
		const complete = fakeHost({
			services: {
				"panara-cloud-convex": { image: "convex", env: completeConvexEnv },
			},
		});
		await expect(
			ensureConvexEnvironment(complete.host, config(), () => {}, {
				restart: false,
			}),
		).resolves.toBe(false);
		expect(complete.commands).toEqual([]);

		const old = fakeHost({
			services: {
				"panara-cloud-convex": {
					image: "convex",
					env: ["INSTANCE_NAME=panara-cloud", "REDACT_LOGS_TO_CLIENT=true"],
				},
			},
		});
		await expect(
			ensureConvexEnvironment(old.host, config(), () => {}, {
				restart: false,
			}),
		).resolves.toBe(true);
		const [update, ...others] = convexUpdates(old.commands);
		expect(others).toEqual([]);
		expect(update).not.toContain("--force");
		expect(update).not.toContain("REDACT_LOGS_TO_CLIENT");
		expect(update).toContain("--env-add MALLOC_ARENA_MAX\\=2");
		expect(bashSyntaxOk(old.commands[0] ?? "")).toBe(true);
	});

	test("the installer runs Convex with log redaction", () => {
		const installSh = readFileSync(
			new URL("../../../../deploy/install.sh", import.meta.url),
			"utf8",
		);
		const deployConvex = installSh.slice(
			installSh.indexOf("deploy_convex() {"),
			installSh.indexOf("deploy_dashboard() {"),
		);
		expect(deployConvex).toContain('"REDACT_LOGS_TO_CLIENT=true"');
	});

	test("the installer runs migrate and panel setup by the image IDs it just pulled", () => {
		const installSh = readFileSync(
			new URL("../../../../deploy/install.sh", import.meta.url),
			"utf8",
		);
		const runs = installSh
			.split("\n")
			.filter((line) => /"\$@" "\$[A-Z_]+" (migrate|panel-setup)\b/.test(line));
		expect(runs).toHaveLength(2);
		expect(runs.find((line) => line.endsWith(" migrate; then"))).toContain(
			'"$MIGRATE_RUN_REF"',
		);
		expect(runs.find((line) => line.endsWith(" panel-setup"))).toContain(
			'"$AGENT_RUN_REF"',
		);
		expect(installSh).toMatch(
			/pull "\$AGENT_REF"\n\tfi\n(\t#[^\n]*\n)*\tAGENT_RUN_REF=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$AGENT_REF"\)/,
		);
		expect(installSh).toMatch(
			/\t\tpull "\$MIGRATE_REF"\n\tfi\n\tMIGRATE_RUN_REF=\$\(docker image inspect --format '\{\{\.Id\}\}' "\$MIGRATE_REF"\)/,
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
					image: "acme/migrate",
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
					image: "acme/migrate",
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

describe("Convex in an update", () => {
	const UPSTREAM = CONVEX_IMAGES_BEFORE_0_1_6[0] ?? "";
	const REPOSITORY = "ghcr.io/acme/panara-cloud-convex";
	const TARGET = `${REPOSITORY}:1.3.0@${DIGEST}`;
	const registry = (async () =>
		Response.json({ tags: ["1.3.0"] })) as typeof fetch;
	const following = () =>
		config({
			convexRepository: REPOSITORY,
			migrator: readPanelConfig({
				PANARA_CLOUD_IMAGES:
					"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
				PANARA_CLOUD_MIGRATOR: "panara-cloud-agent",
				PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE: "/etc/panara-cloud/secrets/key",
			}).migrator,
		});
	const env = [
		"INSTANCE_NAME=panara-cloud",
		...CONVEX_SETTINGS.map((setting) => `${setting.name}=${setting.value}`),
	];
	// A panel whose Convex runs `image`; `--image` updates of Convex take
	// effect, or fail (`moveFails`) after Swarm took the new spec.
	const panel = (
		image: string,
		options: { moveFails?: boolean; pullFails?: boolean } = {},
	) => {
		const services: Record<string, FakeService> = {
			"panara-cloud-web": { image: "web" },
			"panara-cloud-agent": { image: "agent" },
			"panara-cloud-convex": { image, env },
		};
		return fakeHost({ services }, (command) => {
			const plain = command.replace(/\\([=:@])/g, "$1");
			if (plain.includes(`pull ${REPOSITORY}`) && options.pullFails) {
				return { code: 1, output: "manifest unknown\n" };
			}
			const move = plain.match(/--image (\S+) panara-cloud-convex$/m);
			if (move?.[1] && services["panara-cloud-convex"]) {
				services["panara-cloud-convex"].image = move[1];
				if (options.moveFails) {
					return { code: 1, output: "update paused due to failure\n" };
				}
			}
			if (plain.includes("service rollback panara-cloud-convex")) {
				if (services["panara-cloud-convex"]) {
					services["panara-cloud-convex"].image = image;
				}
			}
			return {
				code: 0,
				output: command.includes("pull") ? `Digest: ${DIGEST}\n` : "",
			};
		});
	};
	const lastLines = (commands: string[]) =>
		commands.map((command) =>
			(command.split("\n").at(-1) ?? "").replace(/\\([=:@])/g, "$1"),
		);

	test("Convex set up by an installer follows the releases; one chosen by hand does not", () => {
		expect(convexFollowsReleases(UPSTREAM, REPOSITORY)).toBe(true);
		expect(
			convexFollowsReleases(`${REPOSITORY}:1.2.0@${DIGEST}`, REPOSITORY),
		).toBe(true);
		expect(
			convexFollowsReleases(
				"ghcr.io/convex/convex-backend@sha256:0000000000000000000000000000000000000000000000000000000000000000",
				REPOSITORY,
			),
		).toBe(false);
		expect(
			convexFollowsReleases("ghcr.io/convex/convex-backend:latest", REPOSITORY),
		).toBe(false);
		expect(
			readPanelConfig({
				PANARA_CLOUD_IMAGES:
					"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent",
			}).convexRepository,
		).toBe(REPOSITORY);
		expect(
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "panara-cloud-web=ghcr.io/acme/panara-cloud-web",
				PANARA_CLOUD_CONVEX_REPOSITORY: "registry.example.com/x/convex:9",
			}).convexRepository,
		).toBe("registry.example.com/x/convex");
		expect(
			readPanelConfig({
				PANARA_CLOUD_IMAGES: "panara-cloud-web=ghcr.io/acme/panara-cloud-web",
				PANARA_CLOUD_CONVEX_REPOSITORY: "none",
			}).convexRepository,
		).toBeNull();
	});

	test("the pre-0.1.6 pin is the one install.sh carries", () => {
		const installSh = readFileSync(
			new URL("../../../../deploy/install.sh", import.meta.url),
			"utf8",
		);
		expect(installSh).toMatch(
			new RegExp(`^CONVEX_IMAGE_BEFORE_0_1_6=${UPSTREAM}$`, "m"),
		);
	});

	test("Convex moves to the release's image, stop-first, before the functions deploy", async () => {
		const { host, commands } = panel(UPSTREAM);
		const lines: string[] = [];
		await updatePanel(host, following(), (line) => lines.push(line), registry);
		const run = lastLines(commands);
		const move = run.findIndex((line) =>
			line.includes(`--image ${TARGET} panara-cloud-convex`),
		);
		expect(run[move]).toBe(
			`timeout 240 $DOCKER service update --quiet --detach=false --with-registry-auth --update-order stop-first --image ${TARGET} panara-cloud-convex`,
		);
		expect(move).toBeGreaterThan(
			run.indexOf(`$DOCKER pull ${REPOSITORY}:1.3.0`),
		);
		expect(move).toBeLessThan(
			run.findIndex((line) => line.endsWith(" migrate")),
		);
		expect(move).toBeLessThan(
			run.findIndex((line) =>
				line.includes("--image ghcr.io/acme/panara-cloud-web"),
			),
		);
		expect(lines).toContain(
			`Moving panara-cloud-convex to ${TARGET}; Convex restarts`,
		);
	});

	test("a Convex already on the release's image, or chosen by hand, stays", async () => {
		for (const image of [
			TARGET,
			"registry.example.com/me/convex-backend:custom",
		]) {
			const { host, commands } = panel(image);
			const lines: string[] = [];
			await updatePanel(
				host,
				following(),
				(line) => lines.push(line),
				registry,
			);
			expect(
				lastLines(commands).some((line) =>
					/--image \S+ panara-cloud-convex$/.test(line),
				),
			).toBe(false);
			if (image !== TARGET) {
				expect(lines).toContain(
					`panara-cloud-convex runs ${image}, an image chosen for it, and stays on it`,
				);
			}
		}
		const off = panel(UPSTREAM);
		await updatePanel(off.host, config(), () => {}, registry);
		expect(off.commands.some((c) => c.includes("panara-cloud-convex:"))).toBe(
			false,
		);
	});

	test("a release without a Convex image leaves Convex where it is and goes on", async () => {
		const { host, commands } = panel(UPSTREAM, { pullFails: true });
		const lines: string[] = [];
		await updatePanel(host, following(), (line) => lines.push(line), registry);
		expect(
			lines.some((line) => line.startsWith("⚠️ panara-cloud-convex stays on")),
		).toBe(true);
		const run = lastLines(commands);
		expect(
			run.some((line) => /--image \S+ panara-cloud-convex$/.test(line)),
		).toBe(false);
		expect(run.some((line) => line.endsWith(" migrate"))).toBe(true);
		expect(
			run.some((line) =>
				line.includes("--image ghcr.io/acme/panara-cloud-agent"),
			),
		).toBe(true);
	});

	test("a Convex that doesn't start on the new image is rolled back and the update stops", async () => {
		const { host, commands } = panel(UPSTREAM, { moveFails: true });
		await expect(
			updatePanel(host, following(), () => {}, registry),
		).rejects.toThrow(
			`Convex did not start on ${TARGET} (update paused due to failure); it was put back on ${UPSTREAM}. Nothing else was changed, and pressing Update again is safe.`,
		);
		const run = lastLines(commands);
		expect(run).toContain(
			"timeout 240 $DOCKER service rollback --quiet --detach=false panara-cloud-convex",
		);
		expect(run.some((line) => line.endsWith(" migrate"))).toBe(false);
		expect(
			run.some((line) =>
				line.includes("--image ghcr.io/acme/panara-cloud-web"),
			),
		).toBe(false);
	});

	test("a migrate that fails after the move says Convex moved", () => {
		expect(migrateFailure(2, "", true)).toBe(
			"The functions deploy exited with status 2. No service but Convex was changed (it runs the release's image, with the functions it had), and pressing Update again is safe.",
		);
	});
});
