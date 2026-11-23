import { describe, expect, test } from "vitest";
import { removeCompose } from "../compose/host";
import { removeDatabase, removeVolumes } from "../databases/service";
import type { Host } from "../host/types";
import type { VolumeChecks } from "../infra/volumeRemoval";
import { removeApplicationFromHost } from "./lifecycle";

// shell-quote escapes "=" in bare words; compare without that.
const unescapeShell = (script: string) => script.replace(/\\([=,:])/g, "$1");

// Records every command; `reply` answers the ones whose output matters.
const fakeHost = (
	reply: (
		command: string,
	) => { code: number; output: string } | undefined = () => undefined,
) => {
	const commands: string[] = [];
	const removedServices: string[] = [];
	const exec = async (command: string) => {
		const plain = unescapeShell(command);
		commands.push(plain);
		return reply(plain) ?? { code: 0, output: "" };
	};
	const host = {
		kind: "local",
		label: "test",
		exec,
		run: async (command: string) => (await exec(command)).output,
		docker: () => ({
			getService: (name: string) => ({
				remove: async () => {
					removedServices.push(name);
				},
			}),
		}),
	} as unknown as Host;
	return { host, commands, removedServices };
};

const volumeCommands = (commands: string[]) =>
	commands.filter((command) => command.includes("volume"));

// Every named volume exists; `holders` says which container still mounts one.
const checks = (holders: Record<string, string> = {}): VolumeChecks => ({
	panelReferences: async () => ({ incomplete: null, volumes: [] }),
	inspect: async (_host, names) => ({
		existing: [...names],
		containers: names.flatMap((name) =>
			holders[name]
				? [
						{
							name: holders[name],
							state: "exited",
							owner: "other",
							volumes: [name],
						},
					]
				: [],
		),
		services: [],
	}),
	pollMs: 0,
});

const removedVolumes = (commands: string[]) =>
	commands.flatMap((command) => {
		const name = command.match(/\$DOCKER volume rm (\S+)/)?.[1];
		return name ? [name] : [];
	});

describe("application removal", () => {
	test("keeps every volume unless some are named", async () => {
		const { host, commands, removedServices } = fakeHost();
		await removeApplicationFromHost(host, "app-web-abc123", {
			removeService: true,
		});
		expect(removedServices).toEqual(["app-web-abc123"]);
		expect(volumeCommands(commands)).toEqual([]);
	});

	test("deletes the named volumes once the service's containers are gone", async () => {
		const { host, commands } = fakeHost();
		const log: string[] = [];
		const { volumes } = await removeApplicationFromHost(
			host,
			"app-web-abc123",
			{
				removeService: true,
				volumes: { ...checks(), names: ["uploads", "cache"] },
				log: (text) => log.push(text),
			},
		);
		const waited = commands.findIndex((command) =>
			command.includes("label=com.docker.swarm.service.name=app-web-abc123"),
		);
		const removed = commands.findIndex((command) =>
			command.includes("$DOCKER volume rm uploads"),
		);
		expect(waited).toBeGreaterThan(-1);
		expect(removed).toBeGreaterThan(waited);
		expect(removedVolumes(commands)).toEqual(["uploads", "cache"]);
		expect(log).toEqual(["Removed volume uploads\n", "Removed volume cache\n"]);
		expect(volumes).toEqual({ removed: ["uploads", "cache"], kept: [] });
	});

	test("keeps a named volume another container still mounts and says why", async () => {
		const { host, commands } = fakeHost();
		const { volumes } = await removeApplicationFromHost(
			host,
			"app-web-abc123",
			{
				removeService: true,
				volumes: {
					...checks({ uploads: "worker-1" }),
					names: ["uploads", "cache"],
				},
			},
		);
		expect(removedVolumes(commands)).toEqual(["cache"]);
		expect(volumes).toEqual({
			removed: ["cache"],
			kept: [
				{
					name: "uploads",
					reason: "still used by container worker-1 (exited)",
				},
			],
		});
	});

	test("a volume the panel already kept is reported and never touched", async () => {
		const { host, commands } = fakeHost();
		const log: string[] = [];
		const kept = [
			{ name: "shared", reason: "still used by Billing (application)" },
		];
		const { volumes } = await removeApplicationFromHost(
			host,
			"app-web-abc123",
			{
				removeService: true,
				volumes: { ...checks(), names: ["uploads"], kept },
				log: (text) => log.push(text),
			},
		);
		expect(removedVolumes(commands)).toEqual(["uploads"]);
		expect(volumes).toEqual({ removed: ["uploads"], kept });
		expect(log).toEqual([
			"Kept volume shared: still used by Billing (application)\n",
			"Removed volume uploads\n",
		]);

		// With nothing left to remove the kept ones are still reported.
		const only = fakeHost();
		const outcome = await removeApplicationFromHost(
			only.host,
			"app-web-abc123",
			{ removeService: true, volumes: { ...checks(), names: [], kept } },
		);
		expect(volumeCommands(only.commands)).toEqual([]);
		expect(outcome.volumes).toEqual({ removed: [], kept });
	});

	test("a build server, which never ran the service, deletes no volumes", async () => {
		const { host, commands, removedServices } = fakeHost();
		await removeApplicationFromHost(host, "app-web-abc123", {
			removeService: false,
			volumes: { ...checks(), names: ["uploads"] },
		});
		expect(removedServices).toEqual([]);
		expect(volumeCommands(commands)).toEqual([]);
	});
});

describe("volume removal", () => {
	test("retries while Docker still reports the volume in use", async () => {
		let attempts = 0;
		const { host } = fakeHost((command) => {
			if (!command.startsWith("docker volume rm")) return undefined;
			attempts++;
			return attempts < 3
				? { code: 1, output: "Error: volume is in use - [abc]" }
				: { code: 0, output: "data" };
		});
		const log: string[] = [];
		await removeVolumes(host, ["data"], (text) => log.push(text), undefined, 0);
		expect(attempts).toBe(3);
		expect(log).toEqual(["Removed volume data\n"]);
	});

	test("gives up on other errors at once and reports them", async () => {
		let attempts = 0;
		const { host } = fakeHost((command) => {
			if (!command.startsWith("docker volume rm")) return undefined;
			attempts++;
			return { code: 1, output: "permission denied" };
		});
		const log: string[] = [];
		await removeVolumes(host, ["data"], (text) => log.push(text), undefined, 0);
		expect(attempts).toBe(1);
		expect(log).toEqual(["Could not remove volume data: permission denied\n"]);
	});

	test("a database keeps its volumes unless they are named", async () => {
		const kept = fakeHost();
		await removeDatabase(kept.host, "pg-main-abc123", { log: () => {} });
		expect(kept.removedServices).toEqual(["pg-main-abc123"]);
		expect(volumeCommands(kept.commands)).toEqual([]);

		const deleted = fakeHost();
		const outcome = await removeDatabase(deleted.host, "pg-main-abc123", {
			log: () => {},
			volumes: { ...checks(), names: ["pg-main-abc123-data"] },
		});
		expect(removedVolumes(deleted.commands)).toEqual(["pg-main-abc123-data"]);
		expect(outcome).toEqual({ removed: ["pg-main-abc123-data"], kept: [] });
	});

	test("a database's data volume that another container mounts is kept", async () => {
		const { host, commands } = fakeHost();
		const outcome = await removeDatabase(host, "pg-main-abc123", {
			log: () => {},
			volumes: {
				...checks({ "pg-main-abc123-data": "pgadmin" }),
				names: ["pg-main-abc123-data"],
			},
		});
		expect(removedVolumes(commands)).toEqual([]);
		expect(outcome.kept).toEqual([
			{
				name: "pg-main-abc123-data",
				reason: "still used by container pgadmin (exited)",
			},
		]);
	});

	test("a transfer drops the copied source volumes as before", async () => {
		const { host, commands } = fakeHost();
		await removeDatabase(host, "pg-main-abc123", {
			log: () => {},
			uncheckedVolumes: ["pg-main-abc123-data"],
		});
		expect(volumeCommands(commands)).toEqual([
			"docker volume rm --force pg-main-abc123-data",
		]);
	});
});

describe("compose removal", () => {
	const log = { append: () => {}, line: () => {} };
	// The project owns two labelled volumes and one anonymous one.
	const projectHost = () =>
		fakeHost((command) =>
			command.includes('echo "<<named"')
				? {
						code: 0,
						output: [
							"<<named",
							"shop-abc123_data",
							"shared",
							"<<mounts",
							JSON.stringify([
								{ Type: "volume", Name: "shop-abc123_data" },
								{ Type: "volume", Name: "f".repeat(64) },
								{ Type: "volume", Name: "someone-elses" },
								{ Type: "bind", Source: "/srv/shop" },
							]),
						].join("\n"),
					}
				: undefined,
		);

	test("without volumes the project is torn down and no volume is touched", async () => {
		for (const composeType of ["docker-compose", "stack"] as const) {
			const { host, commands } = fakeHost();
			const outcome = await removeCompose(
				host,
				{ appName: "shop-abc123", composeType, deleteVolumes: false },
				log,
			);
			const script = commands.join("\n");
			expect(script).toContain(
				composeType === "stack"
					? "stack rm shop-abc123"
					: "compose -p shop-abc123 down --remove-orphans 2>&1",
			);
			expect(script).not.toContain("volume");
			expect(outcome).toEqual({ removed: [], kept: [] });
		}
	});

	test("without volumes the data bind mounts wrote under the service's directory stays", async () => {
		const { host, commands } = fakeHost();
		await removeCompose(
			host,
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				deleteVolumes: false,
			},
			log,
		);
		const script = commands.join("\n");
		expect(script).not.toMatch(
			/rm -rf \/etc\/panara-cloud\/compose\/shop-abc123( |$)/m,
		);
		expect(script).toContain(
			"rm -f /etc/panara-cloud/compose/shop-abc123/code/.env",
		);
		expect(script).toContain(
			"rm -f /etc/panara-cloud/compose/shop-abc123/code/docker-compose.yml",
		);
		expect(script).toContain(
			"rm -rf /etc/panara-cloud/compose-state/shop-abc123",
		);
	});

	// The agent's record of the last deploy's source, or (none recorded) what
	// the `.git` check answers.
	const sourceHost = (recorded: string | null, gitCheck = "raw") =>
		fakeHost((command) =>
			command.includes("compose-state/shop-abc123/source") &&
			command.includes("cat <&3")
				? recorded === null
					? { code: 3, output: "" }
					: { code: 0, output: recorded }
				: command.includes("/code/.git")
					? { code: 0, output: `${gitCheck}\n` }
					: undefined,
		);
	const keepData = {
		appName: "shop-abc123",
		composeType: "docker-compose" as const,
		deleteVolumes: false,
	};
	const removesCheckout = (commands: string[]) => {
		const script = commands.join("\n");
		expect(script).not.toMatch(
			/rm -rf \/etc\/panara-cloud\/compose\/shop-abc123( |$)/m,
		);
		expect(script).not.toContain("shop-abc123/files");
		return script.includes("rm -rf /etc/panara-cloud/compose/shop-abc123/code");
	};

	test("without volumes a git service loses its checkout (and any nested .env), not files/", async () => {
		const { host, commands } = sourceHost("git\n");
		await removeCompose(host, keepData, log);
		expect(removesCheckout(commands)).toBe(true);
		expect(commands.some((c) => c.includes("/code/.git"))).toBe(false);
	});

	test("without volumes a raw service keeps code/, whatever a container put there", async () => {
		const { host, commands } = sourceHost("raw\n", "git");
		await removeCompose(host, keepData, log);
		expect(removesCheckout(commands)).toBe(false);
		expect(commands.join("\n")).toContain(
			"rm -f /etc/panara-cloud/compose/shop-abc123/code/.env",
		);
	});

	test("with no record (an older agent deployed it), only a real .git folder makes it a checkout", async () => {
		const git = sourceHost(null, "git");
		await removeCompose(git.host, keepData, log);
		expect(removesCheckout(git.commands)).toBe(true);
		const check = git.commands.find((c) => c.includes("/code/.git")) ?? "";
		expect(check).toContain(
			"[ -d /etc/panara-cloud/compose/shop-abc123/code/.git ]",
		);
		expect(check).toContain(
			"[ ! -L /etc/panara-cloud/compose/shop-abc123/code/.git ]",
		);
		const raw = sourceHost(null, "raw");
		await removeCompose(raw.host, keepData, log);
		expect(removesCheckout(raw.commands)).toBe(false);
	});

	test("with volumes the service's directory goes too", async () => {
		const { host, commands } = projectHost();
		await removeCompose(
			host,
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				deleteVolumes: true,
			},
			log,
			{ checks: checks() },
		);
		expect(commands.join("\n")).toMatch(
			/rm -rf \/etc\/panara-cloud\/compose\/shop-abc123( |$)/m,
		);
	});

	test("the images it built are looked at once its containers are gone", async () => {
		const { host, commands } = fakeHost();
		await removeCompose(
			host,
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				deleteVolumes: false,
			},
			log,
		);
		const down = commands.findIndex((command) =>
			command.includes("compose -p shop-abc123 down"),
		);
		const images = commands.findIndex((command) =>
			command.includes(
				"image ls -a -q --no-trunc --filter label=com.docker.compose.project=shop-abc123",
			),
		);
		expect(down).toBeGreaterThan(-1);
		expect(images).toBeGreaterThan(down);
	});

	test("with volumes, compose never removes them itself: each one is decided", async () => {
		const { host, commands } = projectHost();
		const outcome = await removeCompose(
			host,
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				deleteVolumes: true,
			},
			log,
			{ checks: checks({ shared: "blog-app-1" }) },
		);
		const script = commands.join("\n");
		expect(script).toContain(
			"$DOCKER volume ls -q --filter label=com.docker.compose.project=shop-abc123",
		);
		expect(script).not.toContain("--volumes");
		const listed = commands.findIndex((command) =>
			command.includes('echo "<<named"'),
		);
		const down = commands.findIndex((command) =>
			command.includes("compose -p shop-abc123 down --remove-orphans 2>&1"),
		);
		expect(listed).toBeGreaterThan(-1);
		expect(down).toBeGreaterThan(listed);
		// Its own named and anonymous volumes go; the shared one, the bind mount
		// and the volume it only used stay.
		expect(removedVolumes(commands)).toEqual([
			"shop-abc123_data",
			"f".repeat(64),
		]);
		expect(outcome).toEqual({
			removed: ["shop-abc123_data", "f".repeat(64)],
			kept: [
				{
					name: "shared",
					reason: "still used by container blog-app-1 (exited)",
				},
			],
		});
	});

	test("a stack's volumes are found by its namespace and decided the same way", async () => {
		const { host, commands } = projectHost();
		const outcome = await removeCompose(
			host,
			{ appName: "shop-abc123", composeType: "stack", deleteVolumes: true },
			log,
			{ checks: checks({ shared: "blog_app.1.x" }) },
		);
		const script = commands.join("\n");
		expect(script).toContain(
			"$DOCKER volume ls -q --filter label=com.docker.stack.namespace=shop-abc123",
		);
		expect(script).toContain("stack rm shop-abc123");
		expect(script).not.toContain('volume rm "$volume"');
		expect(outcome.kept.map((kept) => kept.name)).toEqual(["shared"]);
	});

	test("a transfer drops the source project's volumes as before", async () => {
		const compose = fakeHost();
		await removeCompose(
			compose.host,
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				deleteVolumes: true,
			},
			log,
		);
		expect(compose.commands.join("\n")).toContain(
			"compose -p shop-abc123 down --remove-orphans --volumes 2>&1",
		);
		const stack = fakeHost();
		await removeCompose(
			stack.host,
			{ appName: "shop-abc123", composeType: "stack", deleteVolumes: true },
			log,
		);
		expect(stack.commands.join("\n")).toContain('$DOCKER volume rm "$volume"');
	});
});
