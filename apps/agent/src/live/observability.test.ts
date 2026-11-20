import { describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { ipamSpec } from "../infra/docker";
import { quote } from "../lib/shell";
import { type LiveConnection, LiveProcess } from "./connection";
import {
	nativeListCommand,
	parseContainerRows,
	parseTaskRows,
	swarmListCommand,
} from "./containers";
import { PREVIEW_BYTES, readContainerFile, readVolumeFile } from "./files";
import { metricsPath } from "./monitoring";
import { assertSwarmAccess, containerIdentity } from "./ownership";
import type { Redeemed } from "./protocol";
import { parseIoToMb, sampleFromContainer, sampleFromHost } from "./samples";
import { startLiveServer } from "./server";
import {
	eventsCommand,
	HISTORY_INTERVAL_MS,
	historyRecorder,
	isPhysicalDisk,
	parseDiskStats,
	parseHostStats,
	parseNetDev,
} from "./streams";
import { packEntry } from "./tar";

const scriptedConn = (
	outputs: Record<string, { code?: number; stdout?: string }>,
) => {
	const ran: string[] = [];
	const conn = {
		run: async (command: string) => {
			ran.push(command);
			const match = Object.entries(outputs).find(([needle]) =>
				command.includes(needle),
			)?.[1];
			return {
				code: match?.code ?? 0,
				stdout: match?.stdout ?? "",
				stderr: "",
			};
		},
	} as unknown as LiveConnection;
	return { conn, ran };
};

describe("docker events history", () => {
	test("replays the selected window before following", () => {
		const now = Date.UTC(2026, 10, 18, 12, 0, 0);
		expect(eventsCommand(null, 15, now)).toBe(
			`docker events --format '{{json .}}' --since ${now / 1000 - 900}`,
		);
		expect(eventsCommand({ organizationId: "org1" }, 60, now)).toBe(
			`docker events --format '{{json .}}' --since ${now / 1000 - 3600} --filter ${quote("label=panara-cloud.organization=org1")}`,
		);
	});
});

describe("host I/O", () => {
	test("sums network bytes without loopback", () => {
		const netDev = [
			"Inter-|   Receive                                                |  Transmit",
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
			"    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0",
			"  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0",
			"docker0: 300 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0",
		].join("\n");
		expect(parseNetDev(netDev)).toEqual({ received: 1300, sent: 2400 });
	});

	test("counts physical disks only", () => {
		const diskstats = [
			"   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0",
			"   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0",
			"   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0",
			" 259       0 nvme0n1 10 0 10 0 10 0 10 0 0 0 0",
			" 259       1 nvme0n1p1 10 0 10 0 10 0 10 0 0 0 0",
		].join("\n");
		expect(parseDiskStats(diskstats)).toEqual({
			read: (2000 + 10) * 512,
			write: (4000 + 10) * 512,
		});
		expect(isPhysicalDisk("vda")).toBe(true);
		expect(isPhysicalDisk("dm-0")).toBe(false);
	});

	test("host stats include block and network I/O", () => {
		const text = [
			"cpu  100 0 0 900 0 0 0 0 0 0",
			"MemTotal:       1000 kB\nMemAvailable:    400 kB",
			"Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 40000000 60000000 40% /",
			"0.50 0.40 0.30 1/100 1234",
			"  eth0: 1000000 1 0 0 0 0 0 0 2000000 1 0 0 0 0 0 0",
			"   8       0 sda 1 0 2048 0 1 0 4096 0 0 0 0",
		].join("\n---\n");
		const { stats } = parseHostStats(text, null);
		expect(stats).toMatchObject({
			netInBytes: 1_000_000,
			netOutBytes: 2_000_000,
			blockReadBytes: 2048 * 512,
			blockWriteBytes: 4096 * 512,
		});
		expect(sampleFromHost(stats)).toMatchObject({
			cpu: "0.00%",
			network: { inputMb: 1, outputMb: 2 },
			block: { readMb: 1.048576, writeMb: 2.097152 },
			disk: { diskTotal: 102.4, diskUsage: 40.96, diskUsedPercentage: 40 },
		});
	});
});

describe("monitoring samples", () => {
	test("converts docker stats rows into monitoring samples", () => {
		expect(
			sampleFromContainer({
				CPUPerc: "1.5%",
				MemUsage: "12MiB / 1GiB",
				BlockIO: "1MB / 2kB",
				NetIO: "3MB / 4MB",
			}),
		).toEqual({
			cpu: "1.5%",
			memory: { used: "12MiB", total: "1GiB" },
			block: { readMb: 1, writeMb: 0.002 },
			network: { inputMb: 3, outputMb: 4 },
		});
		expect(parseIoToMb("1.5GiB")).toBeCloseTo(1610.612736);
		expect(parseIoToMb(undefined)).toBe(0);
	});

	test("records at most one reading per interval", async () => {
		let now = 0;
		const recorded: string[] = [];
		const record = historyRecorder(
			{
				redeemed: { sessionId: "s1" } as Redeemed,
				services: {
					touchSandbox: async () => true,
					sandboxGone: async () => {},
					recordStats: async (_id, sample) => {
						recorded.push(sample.cpu);
						return true;
					},
				},
				log: () => {},
			},
			() => now,
		);
		const sample = (cpu: string) => sampleFromContainer({ CPUPerc: cpu });
		now = HISTORY_INTERVAL_MS;
		record(sample("1%"));
		await vi.waitFor(() => expect(recorded).toEqual(["1%"]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		now += 1000;
		record(sample("2%"));
		now += HISTORY_INTERVAL_MS;
		record(sample("3%"));
		await vi.waitFor(() => expect(recorded).toEqual(["1%", "3%"]));
	});
});

describe("service containers", () => {
	test("native listings filter by the service and the caller's labels", () => {
		expect(nativeListCommand({ appName: "shop" }, null)).toBe(
			`docker ps -a --filter ${quote("label=com.docker.swarm.service.name=shop")} --format '{{json .}}'`,
		);
		expect(
			nativeListCommand(
				{ appName: "shop", appType: "docker-compose" },
				{ organizationId: "org1" },
			),
		).toBe(
			`docker ps -a --filter ${quote("label=com.docker.compose.project=shop")} --filter ${quote("label=panara-cloud.organization=org1")} --format '{{json .}}'`,
		);
		expect(swarmListCommand({ appName: "shop" })).toBe(
			"docker service ps shop --no-trunc --format '{{json .}}'",
		);
		expect(swarmListCommand({ appName: "shop", appType: "stack" })).toBe(
			"docker stack ps shop --no-trunc --format '{{json .}}'",
		);
	});

	test("parses containers and swarm tasks with node and error", () => {
		expect(
			parseContainerRows(
				'{"ID":"abc","Names":"shop.1.x","State":"running","Status":"Up 2 minutes"}\n',
			),
		).toEqual([
			{
				containerId: "abc",
				name: "shop.1.x",
				state: "running",
				status: "Up 2 minutes",
			},
		]);
		expect(
			parseTaskRows(
				'{"ID":"t1","Name":"shop.1","DesiredState":"Shutdown","Node":"node-2","CurrentState":"Failed 3 minutes ago","Error":"task: non-zero exit (1)"}\n',
			),
		).toEqual([
			{
				containerId: "t1",
				name: "shop.1",
				state: "Shutdown",
				node: "node-2",
				currentState: "Failed 3 minutes ago",
				error: "task: non-zero exit (1)",
			},
		]);
	});

	test("container and service names come with the access check", async () => {
		const { conn } = scriptedConn({
			"--type container": {
				stdout: 'abc123 /shop-web-1 {"panara-cloud.organization":"org1"}\n',
			},
			"--type service": {
				stdout: 'shop {"panara-cloud.organization":"org1"}\n',
			},
		});
		expect(
			await containerIdentity(conn, "abc", { organizationId: "org1" }),
		).toEqual({ id: "abc123", name: "shop-web-1" });
		await expect(
			containerIdentity(conn, "abc", { organizationId: "org2" }),
		).rejects.toThrow(/Not authorized/);
		expect(
			await assertSwarmAccess(conn, "t1", { organizationId: "org1" }),
		).toBe("shop");
	});
});

describe("paid monitoring", () => {
	test("reads every point when asked for all", () => {
		expect(metricsPath("all", null)).toBe("/metrics?limit=all");
		expect(metricsPath(2000, "shop-web-1")).toBe(
			"/metrics/containers?limit=2000&appName=shop-web-1",
		);
	});
});

describe("file previews", () => {
	test("large files open truncated instead of failing", async () => {
		const big = Buffer.alloc(PREVIEW_BYTES + 10, "a");
		const archive = packEntry({ name: "big.log", type: "file", content: big });
		const { conn } = scriptedConn({
			"docker cp": { stdout: archive.toString("base64") },
		});
		const preview = await readContainerFile(conn, "abc", "/big.log", {
			maxBytes: PREVIEW_BYTES,
			truncate: true,
		});
		expect(preview).toMatchObject({
			size: PREVIEW_BYTES + 10,
			truncated: true,
			encoding: "utf8",
		});
		expect(preview.content).toHaveLength(PREVIEW_BYTES);
		await expect(
			readContainerFile(conn, "abc", "/big.log", { maxBytes: PREVIEW_BYTES }),
		).rejects.toThrow(/limit/);

		const volume = scriptedConn({
			"docker run": {
				stdout: `${PREVIEW_BYTES + 10}\n${big.subarray(0, PREVIEW_BYTES).toString("base64")}`,
			},
		});
		expect(
			await readVolumeFile(volume.conn, "data", "/big.log", {
				maxBytes: PREVIEW_BYTES,
				truncate: true,
			}),
		).toMatchObject({ truncated: true, size: PREVIEW_BYTES + 10 });
	});
});

describe("networks", () => {
	test("always sends the IPAM driver", () => {
		expect(ipamSpec({ driver: "custom-ipam", config: [] })).toEqual({
			Driver: "custom-ipam",
		});
		expect(ipamSpec({ config: [{ subnet: "10.9.0.0/24" }] })).toEqual({
			Driver: "default",
			Config: [{ Subnet: "10.9.0.0/24" }],
		});
	});
});

const scriptedLive = (
	outputs: [needle: string, stdout: string][],
): LiveConnection => {
	const run = async (command: string) => ({
		code: 0,
		stdout: outputs.find(([needle]) => command.includes(needle))?.[1] ?? "",
		stderr: "",
	});
	return {
		kind: "local",
		run,
		runOk: async (command: string) => (await run(command)).stdout,
		spawn: async () => {
			const proc = new LiveProcess({
				write: () => {},
				end: () => {},
				kill: () => proc.markExited(null),
			});
			return proc;
		},
		close: () => {},
	} as unknown as LiveConnection;
};

const session = (
	sessionId: string,
	request: Redeemed["request"],
): Redeemed => ({
	sessionId: sessionId as Redeemed["sessionId"],
	organizationId: "org1",
	userId: "u1",
	request,
	restriction: { organizationId: "org1" },
	target: { type: "local" },
	extra: { type: "none" },
});

const connect = (port: number, token: string) =>
	new Promise<{ ws: WebSocket; messages: { type: string }[] }>(
		(resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${token}`);
			const messages: { type: string }[] = [];
			ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
			ws.on("open", () => resolve({ ws, messages }));
			ws.on("error", reject);
		},
	);

describe("live server sessions", () => {
	test("lists containers, names log streams and records stats history", async () => {
		const scope = { type: "host" as const, organizationId: "org1" };
		const tokens = new Map<string, Redeemed>([
			[
				"list-token-0123456789",
				session("s1", {
					kind: "serviceContainers",
					scope,
					appName: "shop",
					mode: "native",
				}),
			],
			[
				"logs-token-0123456789",
				session("s2", {
					kind: "containerLogs",
					scope,
					containerId: "abc",
					runType: "native",
					tail: 10,
					since: "all",
					timestamps: true,
				}),
			],
			[
				"stats-token-0123456789",
				session("s3", {
					kind: "containerStats",
					scope,
					target: { type: "container", containerId: "abc" },
				}),
			],
		]);
		const recorded: [string, string][] = [];
		const server = startLiveServer({
			port: 0,
			host: "127.0.0.1",
			redeem: async (token) => tokens.get(token) ?? null,
			reportClosed: async () => {},
			services: {
				touchSandbox: async () => true,
				sandboxGone: async () => {},
				recordStats: async (id, sample) => {
					recorded.push([id, sample.cpu]);
					return true;
				},
			},
			openConnection: async () =>
				scriptedLive([
					[
						"docker ps -a",
						'{"ID":"abc","Names":"shop.1.x","State":"running","Status":"Up"}\n',
					],
					[
						"--type container",
						'abc123 /shop.1.x {"panara-cloud.organization":"org1"}',
					],
					[
						"docker stats",
						'{"CPUPerc":"4.2%","MemUsage":"1MiB / 2GiB","BlockIO":"0B / 0B","NetIO":"1kB / 2kB"}',
					],
				]),
		});
		const port = await server.listening;

		const list = await connect(port, "list-token-0123456789");
		await vi.waitFor(() =>
			expect(list.messages.map((m) => m.type)).toEqual(["ready", "list"]),
		);
		expect(list.messages[1]).toEqual({
			type: "list",
			data: [
				{
					containerId: "abc",
					name: "shop.1.x",
					state: "running",
					status: "Up",
				},
			],
		});

		const logs = await connect(port, "logs-token-0123456789");
		await vi.waitFor(() => expect(logs.messages[0]?.type).toBe("ready"));
		expect(logs.messages[0]).toMatchObject({ info: { name: "shop.1.x" } });

		const stats = await connect(port, "stats-token-0123456789");
		await vi.waitFor(() => expect(recorded).toEqual([["s3", "4.2%"]]));
		expect(stats.messages.some((m) => m.type === "stats")).toBe(true);

		for (const client of [list, logs, stats]) client.ws.close();
		await server.close();
	});
});
