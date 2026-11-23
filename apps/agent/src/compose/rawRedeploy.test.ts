import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import {
	assertNoProtectedBinds,
	bindsInsideProject,
	orphanedVolumes,
	prepareSource,
	protectedBinds,
	resolvedVolumeNames,
} from "./host";

// Records every command. `existing` paths exist, and `recorded` is the
// source the agent's state folder says the last deploy had (null: none
// recorded).
const fakeHost = (
	existing: string[],
	{ recorded = null }: { recorded?: string | null } = {},
) => {
	const commands: string[] = [];
	const exec = async (command: string) => {
		commands.push(command);
		const tested = command.match(/^test -[de] '?([^']+)'?$/)?.[1];
		if (tested !== undefined) {
			return { code: existing.includes(tested) ? 0 : 1, output: "" };
		}
		if (command.includes("compose-state/shop-tolgee-abc123/source")) {
			if (command.includes("cat <&3")) {
				return recorded === null
					? { code: 3, output: "" }
					: { code: 0, output: `${recorded}\n` };
			}
		}
		return { code: 0, output: "" };
	};
	const host = {
		kind: "ssh",
		label: "test",
		exec,
		run: async (command: string) => (await exec(command)).output,
	} as unknown as Host;
	return { host, commands };
};

const input = {
	compose: {
		id: "c1",
		organizationId: "o1",
		projectId: "p1",
		environmentId: "e1",
		name: "tolgee",
		appName: "shop-tolgee-abc123",
		composeType: "docker-compose" as const,
		sourceType: "raw" as const,
		composePath: "./docker-compose.yml",
		command: "",
		createEnvFile: true,
		randomize: false,
		suffix: "",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		pullImages: false,
	},
	composeFile: "services: {}\n",
	env: "",
	projectEnv: "",
	environmentEnv: "",
	domains: [],
	mounts: [],
	serviceNetworks: [],
};
const log = { line: () => {}, append: () => {} };
const recordingLog = () => {
	const lines: string[] = [];
	return {
		lines,
		log: { line: (l: string) => lines.push(l), append: () => {} },
	};
};
const code = "/etc/panara-cloud/compose/shop-tolgee-abc123/code";

describe("a raw compose redeploy", () => {
	test("keeps the project directory, where `./` bind mounts keep their data", async () => {
		const { host, commands } = fakeHost([code]);
		await prepareSource(
			host,
			input,
			{ type: "raw", composeFile: "services: {}\n" },
			log,
		);
		const script = commands.join("\n");
		expect(script).not.toContain(`rm -rf ${code}`);
		expect(script).toContain(`rm -f ${code}/.env`);
		expect(script).toContain("docker-compose.yml");
	});

	test("clears the checkout the first time after a git source, then never again", async () => {
		const raw = { type: "raw" as const, composeFile: "services: {}\n" };
		const first = fakeHost([code, `${code}/.git`], { recorded: "git" });
		await prepareSource(first.host, input, raw, log);
		expect(first.commands.join("\n")).toContain(`rm -rf ${code}`);
		expect(first.commands.join("\n")).toContain(
			"compose-state/shop-tolgee-abc123/source",
		);
		// A container that ran `git init` in a ./ mount changes nothing now.
		const later = fakeHost([code, `${code}/.git`], { recorded: "raw" });
		await prepareSource(later.host, input, raw, log);
		expect(later.commands.join("\n")).not.toContain(`rm -rf ${code}`);
	});

	test("with nothing recorded, code/ is kept even with a real .git directory, and the log says so", async () => {
		// A container can `git init` in a ./ mount; only the agent's own record
		// of a git deploy clears the folder.
		const raw = { type: "raw" as const, composeFile: "services: {}\n" };
		const real = fakeHost([code, `${code}/.git`]);
		const { lines, log: kept } = recordingLog();
		await prepareSource(real.host, input, raw, kept);
		expect(real.commands.join("\n")).not.toContain(`rm -rf ${code}`);
		expect(real.commands.join("\n")).toContain(`rm -f ${code}/.env`);
		expect(
			lines.filter((line) => line.startsWith(`Kept ${code}`)),
		).toHaveLength(1);
		const fresh = fakeHost([]);
		const { lines: freshLines, log: freshLog } = recordingLog();
		await prepareSource(fresh.host, input, raw, freshLog);
		expect(freshLines.some((line) => line.startsWith("Kept"))).toBe(false);
	});
});

describe("volumes an earlier deploy created", () => {
	test("are reported when the compose file no longer names them", () => {
		const expected = resolvedVolumeNames({
			volumes: {
				data: { name: "shop-abc123_data" },
				"data-1a2b3c4d": { name: "shop-abc123_data-1a2b3c4d" },
			},
		} as never);
		expect(expected.names).toEqual([
			"shop-abc123_data",
			"shop-abc123_data-1a2b3c4d",
		]);
		expect(
			orphanedVolumes(
				["shop-abc123_data", "shop-abc123_db", "f".repeat(64), ""],
				expected,
			),
		).toEqual(["shop-abc123_db"]);
	});

	test("a name left with a variable matches any value, the rest are still judged", () => {
		const expected = resolvedVolumeNames({
			volumes: {
				data: { name: "${X}-data" },
				db: { name: "shop-abc123_db" },
			},
		} as never);
		expect(expected).toEqual({
			names: ["shop-abc123_db"],
			unresolved: [{ key: "data", name: "${X}-data" }],
		});
		expect(
			orphanedVolumes(
				["harbor-1-data", "shop-abc123_db", "shop-abc123_old"],
				expected,
			),
		).toEqual(["shop-abc123_old"]);
	});

	test("a name that is only a variable hides nothing but its own volume", () => {
		const expected = resolvedVolumeNames({
			volumes: { data: { name: "${VOLUME}" }, db: { name: "shop-abc123_db" } },
		} as never);
		expect(
			orphanedVolumes(
				[
					"whatever-it-was\tdata",
					"shop-abc123_db\tdb",
					"shop-abc123_old\told",
					"shop-abc123_cache",
				],
				expected,
			),
		).toEqual(["shop-abc123_old", "shop-abc123_cache"]);
	});
});

const BASE = "/etc/panara-cloud/compose/shop-abc123";

describe("bind mounts inside the project directory", () => {
	test("are found in the resolved file, whatever file declared them", () => {
		expect(
			bindsInsideProject(
				{
					services: {
						app: {
							volumes: [
								{ type: "bind", source: `${BASE}/code/data`, target: "/data" },
								{ type: "bind", source: `${BASE}/files/x`, target: "/x" },
								{ type: "volume", source: "named", target: "/n" },
								{ type: "bind", source: "/srv", target: "/srv" },
								{ type: "bind", source: `${BASE}/code`, target: "/compose" },
							],
						},
					},
				} as never,
				`${BASE}/code`,
			),
		).toEqual([`app mounts ${BASE}/code/data`, `app mounts ${BASE}/code`]);
	});
});

describe("writable bind mounts of protected host folders", () => {
	const bind = (source: string, read_only?: boolean) => ({
		type: "bind",
		source,
		target: "/x",
		...(read_only ? { read_only } : {}),
	});
	const spec = (...volumes: unknown[]) =>
		({ services: { app: { volumes } } }) as never;

	test("are found in the folders and below them, normalised", () => {
		expect(
			protectedBinds(
				spec(
					bind("/root"),
					bind("/root/.ssh/"),
					bind("/root/trilium-backups"),
					bind("/srv/../etc/ssh"),
					bind("/home/me/./x"),
					bind("/var/lib/docker/volumes"),
					bind("/"),
				),
				BASE,
			),
		).toEqual([
			"app mounts the host's /root writable",
			"app mounts the host's /root/.ssh writable",
			"app mounts the host's /root/trilium-backups writable",
			"app mounts the host's /etc/ssh writable",
			"app mounts the host's /home/me/x writable",
			"app mounts the host's /var/lib/docker/volumes writable",
			"app mounts the host's / writable",
		]);
	});

	test("read-only binds, data folders, the Docker socket and the service's own folder pass", () => {
		expect(
			protectedBinds(
				spec(
					bind("/", true),
					bind("/root", true),
					bind("/etc/localtime", true),
					bind("/var/run/docker.sock"),
					bind("/var/log/app"),
					bind("/srv/media"),
					bind("/opt/app/data"),
					bind(`${BASE}/files/data`),
					bind(`${BASE}/code/data`),
					{ type: "volume", source: "data", target: "/data" },
				),
				BASE,
			),
		).toEqual([]);
	});

	test("named volumes whose driver options bind a protected folder count too", () => {
		const volumes = (opts: object) =>
			({
				services: { app: { volumes: [{ type: "volume", source: "d" }] } },
				volumes: { d: { driver: "local", driver_opts: opts } },
			}) as never;
		for (const opts of [
			{ type: "none", o: "bind", device: "/root" },
			{ o: "bind", device: "/home/me" },
			{ type: "none", device: "/etc/../root/.ssh" },
			{ device: "/" },
		]) {
			expect(
				protectedBinds(volumes(opts), BASE),
				JSON.stringify(opts),
			).toHaveLength(1);
		}
		for (const opts of [
			{ type: "none", o: "bind,ro", device: "/root" },
			{ type: "none", o: "bind", device: "/srv/data" },
			{ type: "none", o: "bind", device: `${BASE}/files/d` },
			{ type: "nfs", o: "addr=10.0.0.1", device: ":/export" },
		]) {
			expect(protectedBinds(volumes(opts), BASE), JSON.stringify(opts)).toEqual(
				[],
			);
		}
		expect(() =>
			assertNoProtectedBinds(
				volumes({ type: "none", o: "bind", device: "/root" }),
				BASE,
			),
		).toThrow(/volume d mounts the host's \/root writable/);
	});

	test("fail the job with a message that says what to change", () => {
		expect(() => assertNoProtectedBinds(spec(bind("/root")), BASE)).toThrow(
			/Refusing to run: app mounts the host's \/root writable.*read-only/,
		);
	});
});
