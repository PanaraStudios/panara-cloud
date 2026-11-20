import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import { quote } from "../lib/shell";
import {
	type AccessLogEntry,
	hourlyCounts,
	parseAccessLog,
	parseQuery,
	queryAccessLog,
} from "./accessLog";
import { LiveConnection } from "./connection";
import {
	decodeWriteContent,
	deleteContainerPath,
	deleteVolumePath,
	encodeContent,
	MAX_WRITE_BYTES,
	normalizePath,
	parseListing,
	writeContainerFile,
	writeVolumeFile,
} from "./files";
import {
	metricsPath,
	monitoringImage,
	monitoringServiceSpec,
	outdatedMonitoring,
} from "./monitoring";
import { labelFilters, labelsAllow } from "./ownership";
import { parseClientMessage, type Redeemed } from "./protocol";
import {
	containerOptions,
	execScript,
	lifetimeCommand,
	validateEnv,
} from "./sandbox";
import { startLiveServer } from "./server";
import {
	allStatsCommand,
	eventsCommand,
	logsCommand,
	parseHostStats,
	parseStatsLines,
} from "./streams";
import { packEntry, readFirstEntry } from "./tar";

describe("protocol", () => {
	test("parses control messages and treats other text as keystrokes", () => {
		expect(
			parseClientMessage('{"type":"resize","cols":120,"rows":40}', false),
		).toEqual({
			type: "resize",
			cols: 120,
			rows: 40,
		});
		expect(
			parseClientMessage('{"type":"resize","cols":0,"rows":40}', false),
		).toBeNull();
		expect(parseClientMessage("ls -la\r", false)).toEqual({
			type: "input",
			data: "ls -la\r",
		});
		expect(parseClientMessage("{not json", false)).toEqual({
			type: "input",
			data: "{not json",
		});
		expect(
			parseClientMessage('{"type":"exec","id":"1","cmd":"echo"}', false),
		).toEqual({
			type: "request",
			id: "1",
			op: "exec",
			payload: { cmd: "echo" },
		});
		expect(parseClientMessage(Buffer.from('{"type":"x"}'), true)).toEqual({
			type: "input",
			data: '{"type":"x"}',
		});
	});
});

describe("commands", () => {
	const logs = {
		kind: "containerLogs" as const,
		scope: { type: "host" as const, organizationId: "o" },
		containerId: "app-1",
		runType: "native" as const,
		tail: 100,
		since: "all",
		timestamps: true,
	};

	test("logs quote every value", () => {
		expect(logsCommand(logs)).toBe(
			"docker container logs --timestamps --tail 100 --follow app-1 2>&1",
		);
		expect(
			logsCommand({
				...logs,
				runType: "swarm",
				since: "5m",
				search: "a'$(id)",
				timestamps: false,
			}),
		).toBe(
			`docker service logs --raw --tail 100 --since 5m --follow app-1 2>&1 | grep --line-buffered -iF -- "a'\\$(id)"`,
		);
	});

	test("events are filtered by the restriction's labels", () => {
		expect(eventsCommand(null)).toBe("docker events --format '{{json .}}'");
		expect(eventsCommand({ organizationId: "org1", serviceId: "svc" })).toBe(
			"docker events --format '{{json .}}' --filter label\\=panara-cloud.organization\\=org1 --filter label\\=panara-cloud.service.id\\=svc",
		);
	});

	test("sandbox exec passes env through a heredoc, not the command line", () => {
		const script = execScript(
			"abc",
			{
				cmd: "echo $SECRET",
				env: { SECRET: "s3cr3t" },
				user: "1000:1000",
				cwd: "/home/user",
			},
			"marker",
		);
		const [first] = script.split("\n");
		expect(first).toContain(
			"docker exec --env-file /dev/fd/3 -w /home/user -u 1000\\:1000 abc",
		);
		expect(first).not.toContain("s3cr3t");
		expect(script).toContain("\nSECRET=s3cr3t\nPANARA_CLOUD_EXEC_ID=marker\n");
		expect(() => validateEnv({ "BAD-KEY": "x" })).toThrow(
			/Invalid environment/,
		);
		expect(() => validateEnv({ OK: "a\nb" })).toThrow(/Invalid environment/);
	});

	test("sandbox containers are locked down and self-expire", () => {
		const options = containerOptions({
			sandboxId: "sb1",
			organizationId: "org1",
			image: "alpine:3.20",
			cpu: 0.5,
			memoryMb: 256,
			pidsLimit: 64,
			networkMode: "isolated",
			env: "A=1\n# comment\nB=2",
			workdir: "/home/user",
			timeoutMs: 30_000,
			deadlineAt: 2_000_000_000_000,
			runtime: null,
		});
		expect(options.name).toBe("panara-cloud-sandbox-sb1");
		expect(options.Env).toEqual(["HOME=/home/user", "A=1", "B=2"]);
		expect(options.HostConfig).toMatchObject({
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			NanoCpus: 500_000_000,
			PidsLimit: 64,
			AutoRemove: true,
			NetworkMode: "panara-cloud-sandboxes-isolated",
		});
		expect(options.Labels).toMatchObject({
			"panara-cloud.organization": "org1",
			"panara-cloud.sandbox.id": "sb1",
		});
		const [, , script] = lifetimeCommand(2_000_000_000_000, 30_000);
		expect(script).toContain("echo 30 2>/dev/null > /.panara-cloud/timeout");
		expect(script).toContain("exec sleep $(( 2000000000 - $(date +%s) ))");
	});

	test("monitoring service port is never public", () => {
		const remote = monitoringServiceSpec({
			isLocal: false,
			port: 4500,
			metricsConfig: { a: 1 },
		});
		expect(remote.TaskTemplate).toMatchObject({
			Networks: [{ Target: "host" }],
			ContainerSpec: {
				Env: expect.arrayContaining(["MONITORING_LISTEN_HOST=127.0.0.1"]),
			},
		});
		expect(remote.EndpointSpec).toBeUndefined();
		const local = monitoringServiceSpec({
			isLocal: true,
			port: 4500,
			metricsConfig: {},
			publish: false,
		});
		expect(local.EndpointSpec).toBeUndefined();
		expect(local.TaskTemplate).toMatchObject({
			Networks: [{ Target: "panara-cloud-network" }],
			ContainerSpec: { Image: monitoringImage() },
		});
		const devAgent = monitoringServiceSpec({
			isLocal: true,
			port: 4500,
			metricsConfig: {},
			publish: true,
		});
		expect(devAgent.EndpointSpec?.Ports?.[0]).toMatchObject({
			PublishedPort: 4500,
			PublishMode: "host",
		});
		expect(metricsPath(50, null)).toBe("/metrics?limit=50");
		expect(metricsPath(10, "my app")).toBe(
			"/metrics/containers?limit=10&appName=my%20app",
		);
	});
});

describe("monitoring reconcile", () => {
	const config = { server: { port: 4600, token: "t" } };
	const running = (image: string) =>
		monitoringServiceSpec({
			isLocal: true,
			port: 4600,
			metricsConfig: config,
			image,
		}) as Parameters<typeof outdatedMonitoring>[0] & object;

	test("a collector on the expected image and layout is left alone", () => {
		const spec = running("reg/panara-cloud-monitoring:1.4.2");
		spec.TaskTemplate = {
			...spec.TaskTemplate,
			ContainerSpec: {
				...spec.TaskTemplate?.ContainerSpec,
				Image: "reg/panara-cloud-monitoring:1.4.2@sha256:abc",
			},
		};
		expect(
			outdatedMonitoring(spec, "reg/panara-cloud-monitoring:1.4.2"),
		).toBeNull();
	});

	test("an older image or layout is redeployed with its settings", () => {
		expect(
			outdatedMonitoring(
				running("reg/panara-cloud-monitoring:1.4.1"),
				"reg/panara-cloud-monitoring:1.4.2",
			),
		).toEqual({ port: 4600, metricsConfig: config });
		const oldLayout = running("reg/panara-cloud-monitoring:1.4.2");
		oldLayout.Labels = { "panara-cloud": "true" };
		expect(
			outdatedMonitoring(oldLayout, "reg/panara-cloud-monitoring:1.4.2"),
		).toEqual({ port: 4600, metricsConfig: config });
	});

	test("a collector without a readable config is not touched", () => {
		expect(outdatedMonitoring(undefined, "x:1")).toBeNull();
		expect(
			outdatedMonitoring(
				{ TaskTemplate: { ContainerSpec: { Image: "x:0", Env: ["A=1"] } } },
				"x:1",
			),
		).toBeNull();
	});
});

describe("monitoring image", () => {
	test("defaults to Panara Cloud's own image", () => {
		expect(monitoringImage({})).toBe(
			"ghcr.io/panarastudios/panara-cloud-monitoring:latest",
		);
		expect(monitoringImage({ PANARA_CLOUD_VERSION: "0.0.0-dev" })).toBe(
			"ghcr.io/panarastudios/panara-cloud-monitoring:latest",
		);
	});

	test("follows the panel's release version or channel", () => {
		expect(monitoringImage({ PANARA_CLOUD_VERSION: "1.4.2" })).toBe(
			"ghcr.io/panarastudios/panara-cloud-monitoring:1.4.2",
		);
		expect(
			monitoringImage({
				PANARA_CLOUD_VERSION: "1.4.2-canary.abc1234",
				PANARA_CLOUD_RELEASE_TAG: "canary",
			}),
		).toBe("ghcr.io/panarastudios/panara-cloud-monitoring:canary");
	});

	test("uses the panel's registry and owner", () => {
		expect(
			monitoringImage({
				PANARA_CLOUD_REGISTRY: "registry.example.com:5000/acme/",
				PANARA_CLOUD_VERSION: "2.0.0",
			}),
		).toBe("registry.example.com:5000/acme/panara-cloud-monitoring:2.0.0");
		expect(
			monitoringImage({
				PANARA_CLOUD_IMAGES:
					"panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent:9.9.9",
				PANARA_CLOUD_VERSION: "2.0.0",
			}),
		).toBe("ghcr.io/acme/panara-cloud-monitoring:2.0.0");
		expect(
			monitoringImage({ PANARA_CLOUD_IMAGES: "web=acme/custom-web" }),
		).toBe("ghcr.io/panarastudios/panara-cloud-monitoring:latest");
	});

	test("an explicit image wins; with a tag or digest it is used as is", () => {
		expect(
			monitoringImage({
				PANARA_CLOUD_MONITORING_IMAGE: "localhost:5000/mon",
				PANARA_CLOUD_REGISTRY: "ghcr.io/acme",
				PANARA_CLOUD_VERSION: "3.1.0",
			}),
		).toBe("localhost:5000/mon:3.1.0");
		expect(
			monitoringImage({
				PANARA_CLOUD_MONITORING_IMAGE: "acme/mon:pinned",
				PANARA_CLOUD_VERSION: "3.1.0",
			}),
		).toBe("acme/mon:pinned");
		expect(
			monitoringImage({ PANARA_CLOUD_MONITORING_IMAGE: "acme/mon@sha256:abc" }),
		).toBe("acme/mon@sha256:abc");
	});
});

describe("ownership", () => {
	const labels = {
		"panara-cloud.organization": "org1",
		"panara-cloud.service.id": "svc1",
	};
	test("restricted sessions only reach labelled containers", () => {
		expect(labelsAllow(null, null)).toBe(true);
		expect(labelsAllow(labels, { organizationId: "org1" })).toBe(true);
		expect(
			labelsAllow(labels, { organizationId: "org1", serviceId: "svc1" }),
		).toBe(true);
		expect(
			labelsAllow(labels, { organizationId: "org1", serviceId: "svc2" }),
		).toBe(false);
		expect(labelsAllow(labels, { organizationId: "org2" })).toBe(false);
		expect(labelsAllow(null, { organizationId: "org1" })).toBe(false);
		expect(labelsAllow({}, { organizationId: "org1" })).toBe(false);
		expect(labelFilters(null)).toEqual([]);
	});
});

describe("files", () => {
	test("tar round trip", () => {
		const tar = packEntry({
			name: "hello.txt",
			type: "file",
			content: Buffer.from("hi\n"),
			uid: 1000,
			gid: 1000,
		});
		expect(tar.length % 512).toBe(0);
		expect(readFirstEntry(tar)).toMatchObject({
			name: "hello.txt",
			type: "file",
			size: 3,
			mode: 0o644,
		});
		expect(readFirstEntry(tar)?.content.toString()).toBe("hi\n");
		expect(
			readFirstEntry(packEntry({ name: "dir", type: "directory" })),
		).toMatchObject({
			name: "dir/",
			type: "directory",
		});
	});

	test("parses stat and ls listings", () => {
		expect(
			parseListing(
				"regular file\t12\t1700000000\t644\t/app/b.txt\ndirectory\t4096\t1700000000\t755\t/app/a\n",
			),
		).toEqual([
			{
				name: "a",
				type: "directory",
				size: 4096,
				mode: "755",
				modifiedAt: "2023-11-14T22:13:20.000Z",
			},
			{
				name: "b.txt",
				type: "file",
				size: 12,
				mode: "644",
				modifiedAt: "2023-11-14T22:13:20.000Z",
			},
		]);
		expect(
			parseListing("__LS__\nz\ny/\n").map((e) => [e.name, e.type]),
		).toEqual([
			["y", "directory"],
			["z", "file"],
		]);
	});

	test("paths and content encoding", () => {
		expect(normalizePath("/a/../b//c")).toBe("/b/c");
		expect(() => normalizePath("relative")).toThrow(/absolute/);
		expect(encodeContent(Buffer.from("text"))).toEqual({
			encoding: "utf8",
			content: "text",
		});
		expect(encodeContent(Buffer.from([0, 255]))).toEqual({
			encoding: "base64",
			content: "AP8=",
		});
	});
});

type Ran = { command: string; input?: string | Buffer };

const fakeConn = (code = 0, stderr = "") => {
	const ran: Ran[] = [];
	const conn = {
		run: async (command: string, options: { input?: string | Buffer } = {}) => {
			ran.push({ command, input: options.input });
			return { code, stdout: "", stderr };
		},
	} as unknown as LiveConnection;
	return { conn, ran };
};

describe("file changes", () => {
	test("decodes utf8 and base64 content within the size limit", () => {
		expect(decodeWriteContent("hi", undefined).toString()).toBe("hi");
		expect(decodeWriteContent("aGk=", "base64").toString()).toBe("hi");
		expect(() => decodeWriteContent(42, "utf8")).toThrow(/string/);
		expect(() =>
			decodeWriteContent("a".repeat(MAX_WRITE_BYTES + 1), "utf8"),
		).toThrow(/limit/);
	});

	test("writes a container file through docker cp of a tar archive", async () => {
		const { conn, ran } = fakeConn();
		await expect(
			writeContainerFile(conn, "abc123", "/app/conf/a.txt", Buffer.from("x")),
		).resolves.toEqual({ path: "/app/conf/a.txt", size: 1 });
		expect(ran[0]?.command).toBe(
			`base64 -d | docker cp - ${quote("abc123:/app/conf")}`,
		);
		const tar = Buffer.from(String(ran[0]?.input), "base64");
		expect(readFirstEntry(tar)).toMatchObject({ name: "a.txt", size: 1 });
	});

	test("deletes paths but never the root", async () => {
		const { conn, ran } = fakeConn();
		await deleteContainerPath(conn, "abc123", "/tmp/x y");
		expect(ran[0]?.command).toBe(
			`docker exec ${quote("abc123")} rm -rf -- ${quote("/tmp/x y")}`,
		);
		await expect(deleteContainerPath(conn, "abc123", "/")).rejects.toThrow(
			/file/,
		);
		await deleteVolumePath(conn, "data", "/old");
		expect(ran[1]?.command).toContain(`-v ${quote("data:/v")} `);
		expect(ran[1]?.command).toContain(quote("/v/old"));
	});

	test("volume writes mount the volume writable and pipe the content", async () => {
		const { conn, ran } = fakeConn();
		await writeVolumeFile(conn, "data", "/a/b.txt", Buffer.from("hi"));
		expect(ran[0]?.command).toContain("docker run --rm -i ");
		expect(ran[0]?.command).toContain(`-v ${quote("data:/v")} `);
		expect(ran[0]?.input).toBe("aGk=");
	});

	test("reports the failure reason", async () => {
		const { conn } = fakeConn(1, "Error: No such container: abc\n");
		await expect(
			writeContainerFile(conn, "abc", "/a", Buffer.from("x")),
		).rejects.toThrow("Error: No such container: abc");
	});
});

describe("all-container stats", () => {
	test("filters by the session's labels", () => {
		expect(allStatsCommand(null)).toBe(
			`ids=$(docker ps -q); [ -z "$ids" ] || docker stats --no-stream --format '{{json .}}' $ids`,
		);
		expect(allStatsCommand({ organizationId: "org1" })).toContain(
			`docker ps -q --filter ${quote("label=panara-cloud.organization=org1")})`,
		);
	});

	test("parses one JSON row per line", () => {
		expect(
			parseStatsLines('{"Name":"a","CPUPerc":"1%"}\nwarning\n{"Name":"b"}\n'),
		).toEqual([{ Name: "a", CPUPerc: "1%" }, { Name: "b" }]);
	});
});

describe("host stats", () => {
	test("computes CPU from successive samples", () => {
		const text = (user: number, idle: number) =>
			[
				`cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0`,
				"MemTotal:       1000 kB\nMemFree:  100 kB\nMemAvailable:    400 kB",
				"Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /",
				"0.50 0.40 0.30 1/100 1234",
			].join("\n---\n");
		const first = parseHostStats(text(100, 900), null);
		expect(first.stats.cpuPercent).toBeNull();
		const second = parseHostStats(text(150, 950), first.sample);
		expect(second.stats).toMatchObject({
			cpuPercent: 50,
			memoryTotal: 1024000,
			memoryUsed: 614400,
			memoryPercent: 60,
			diskTotal: 102400,
			diskUsed: 40960,
			load: [0.5, 0.4, 0.3],
		});
	});
});

const entry = (overrides: Partial<AccessLogEntry>): string =>
	JSON.stringify({
		StartUTC: "2026-11-17T10:15:00Z",
		DownstreamStatus: 200,
		RequestHost: "app.example.com",
		RequestPath: "/",
		RequestMethod: "GET",
		ServiceName: "app@docker",
		...overrides,
	});

describe("access log", () => {
	const raw = [
		entry({ RequestPath: "/a", StartUTC: "2026-11-17T10:15:00Z" }),
		entry({
			DownstreamStatus: 404,
			RequestPath: "/missing",
			StartUTC: "2026-11-17T11:01:00Z",
		}),
		entry({
			DownstreamStatus: 502,
			RequestHost: "api.example.com",
			StartUTC: "2026-11-17T11:30:00Z",
		}),
		entry({ ServiceName: "panara-cloud-service-app@file" }),
		"not json",
		"{broken",
	].join("\n");

	test("parses, filters, sorts and paginates", () => {
		const entries = parseAccessLog(raw);
		expect(entries).toHaveLength(3);
		const all = queryAccessLog(entries, {
			page: { pageIndex: 0, pageSize: 2 },
		});
		expect(all.totalCount).toBe(3);
		expect(all.data.map((e) => e.StartUTC)).toEqual([
			"2026-11-17T11:30:00Z",
			"2026-11-17T11:01:00Z",
		]);
		expect(
			queryAccessLog(entries, { page: { pageIndex: 1, pageSize: 2 } }).data,
		).toHaveLength(1);
		expect(
			queryAccessLog(entries, {
				page: { pageIndex: 0, pageSize: 10 },
				status: ["client", "server"],
			}).totalCount,
		).toBe(2);
		expect(
			queryAccessLog(entries, {
				page: { pageIndex: 0, pageSize: 10 },
				host: "API.",
			}).totalCount,
		).toBe(1);
		expect(
			queryAccessLog(entries, {
				page: { pageIndex: 0, pageSize: 10 },
				path: "/miss",
			}).totalCount,
		).toBe(1);
		expect(
			queryAccessLog(entries, {
				page: { pageIndex: 0, pageSize: 10 },
				dateRange: { start: "2026-11-17T11:00:00Z" },
			}).totalCount,
		).toBe(2);
		expect(hourlyCounts(entries)).toEqual([
			{ hour: "2026-11-17T10:00:00Z", count: 1 },
			{ hour: "2026-11-17T11:00:00Z", count: 2 },
		]);
	});

	test("query parsing drops unknown values", () => {
		expect(
			parseQuery({
				page: { pageIndex: 2, pageSize: 25 },
				status: ["server", "bogus"],
				sort: { id: "x y" },
			}),
		).toMatchObject({
			page: { pageIndex: 2, pageSize: 25 },
			status: ["server"],
			sort: undefined,
		});
	});
});

const redeemedFor = (
	sessionId: string,
	request: Redeemed["request"],
): Redeemed => ({
	sessionId: sessionId as Redeemed["sessionId"],
	organizationId: "org1",
	userId: "u1",
	request,
	restriction: null,
	target: { type: "local" },
	extra: { type: "none" },
});

const connectClient = (port: number, token: string) =>
	new Promise<{
		ws: WebSocket;
		messages: unknown[];
		closed: Promise<{ code: number; reason: string }>;
	}>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${token}`);
		const messages: unknown[] = [];
		const closed = new Promise<{ code: number; reason: string }>((done) =>
			ws.on("close", (code, reason) =>
				done({ code, reason: reason.toString() }),
			),
		);
		ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
		ws.on("open", () => resolve({ ws, messages, closed }));
		ws.on("unexpected-response", (_req, res) =>
			reject(new Error(`HTTP ${res.statusCode}`)),
		);
		ws.on("error", reject);
	});

const waitFor = async (check: () => boolean, ms = 3000) => {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("live server", () => {
	const setupServer = (options: { idleMs?: number } = {}) => {
		const closed: [string, string][] = [];
		const tokens = new Map<string, Redeemed>([
			[
				"access-token-0123456789",
				redeemedFor("s1", { kind: "accessLog", organizationId: "org1" }),
			],
			[
				"access-token-abcdefghij",
				redeemedFor("s2", { kind: "accessLog", organizationId: "org1" }),
			],
		]);
		const server = startLiveServer({
			port: 0,
			host: "127.0.0.1",
			idleMs: options.idleMs,
			redeem: async (token) => {
				const redeemed = tokens.get(token);
				if (!redeemed) throw new Error("Invalid or used token");
				tokens.delete(token);
				return redeemed;
			},
			reportClosed: async (sessionId, reason) => {
				closed.push([sessionId, reason]);
			},
			services: { touchSandbox: async () => true, sandboxGone: async () => {} },
			openConnection: LiveConnection.open,
		});
		return { server, closed };
	};

	test("rejects bad tokens before upgrading and tokens are single-use", async () => {
		const { server } = setupServer();
		const port = await server.listening;
		await expect(connectClient(port, "nope")).rejects.toThrow(/HTTP 401/);
		const { ws } = await connectClient(port, "access-token-0123456789");
		ws.close();
		await expect(
			connectClient(port, "access-token-0123456789"),
		).rejects.toThrow(/HTTP 401/);
		await server.close();
	});

	test("serves requests, then a kill closes the stream and is reported", async () => {
		const { server, closed } = setupServer();
		const port = await server.listening;
		const client = await connectClient(port, "access-token-0123456789");
		client.ws.send(
			JSON.stringify({
				type: "query",
				id: "q1",
				page: { pageIndex: 0, pageSize: 10 },
			}),
		);
		await waitFor(() =>
			client.messages.some((m) => (m as { type: string }).type === "result"),
		);
		expect(client.messages[0]).toEqual({
			type: "ready",
			sessionId: "s1",
			kind: "accessLog",
		});
		expect(client.messages[1]).toEqual({
			type: "result",
			id: "q1",
			ok: true,
			data: { data: [], totalCount: 0 },
		});
		server.kill("s1");
		expect(await client.closed).toEqual({ code: 4009, reason: "Killed" });
		await waitFor(() => closed.length === 1);
		expect(closed).toEqual([["s1", "Killed"]]);
		await server.close();
	});

	test("interactive sessions close when idle", async () => {
		const { server, closed } = setupServer({ idleMs: 100 });
		const port = await server.listening;
		const client = await connectClient(port, "access-token-abcdefghij");
		expect(await client.closed).toEqual({ code: 4008, reason: "Idle timeout" });
		await waitFor(() => closed.length === 1);
		expect(closed[0]).toEqual(["s2", "Idle timeout"]);
		await server.close();
	});
});
