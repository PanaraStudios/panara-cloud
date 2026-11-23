import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import type { Redeemed } from "./protocol";
import { startLiveServer } from "./server";
import { type ReadSnapshot, SnapshotReadings } from "./snapshot";

type Report = {
	sessionId: string;
	data: string;
	error?: string;
	force: boolean;
};

const snapshotSession = (
	sessionId: string,
	request: Partial<Extract<Redeemed["request"], { kind: "hostSnapshot" }>>,
): Redeemed => ({
	sessionId: sessionId as Redeemed["sessionId"],
	organizationId: "org1",
	userId: "u1",
	request: {
		kind: "hostSnapshot",
		what: "containers",
		intervalMs: 150,
		...request,
	},
	restriction: null,
	target: { type: "local" },
	extra: { type: "none" },
});

const waitFor = async (check: () => boolean, ms = 3000) => {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
};

const connect = (port: number, token: string) =>
	new Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }>(
		(resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${token}`);
			const messages: Record<string, unknown>[] = [];
			ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
			ws.on("open", () => resolve({ ws, messages }));
			ws.on("error", reject);
		},
	);

const setup = (
	sessions: Record<string, Redeemed>,
	read: ReadSnapshot,
	storeResult = true,
) => {
	const reports: Report[] = [];
	const closed: string[] = [];
	const server = startLiveServer({
		port: 0,
		host: "127.0.0.1",
		redeem: async (token) => sessions[token] ?? null,
		reportClosed: async (sessionId) => {
			closed.push(sessionId);
		},
		services: {
			touchSandbox: async () => true,
			sandboxGone: async () => {},
			reportSnapshot: async (sessionId, reading) => {
				reports.push({ sessionId, ...reading });
				return storeResult;
			},
		},
		openConnection: async () => {
			throw new Error("a snapshot session opens no live connection");
		},
		readSnapshot: read,
	});
	return { server, reports, closed };
};

describe("host snapshot sessions", () => {
	test("store the first reading at once, then one per interval, without a job", async () => {
		let reads = 0;
		const { server, reports, closed } = setup(
			{ "snapshot-token-0123456789": snapshotSession("s1", {}) },
			async (_target, what) => {
				reads++;
				return [{ what, n: reads }];
			},
		);
		const port = await server.listening;
		const client = await connect(port, "snapshot-token-0123456789");
		await waitFor(() => reports.length >= 3);
		expect(client.messages[0]).toEqual({
			type: "ready",
			sessionId: "s1",
			kind: "hostSnapshot",
		});
		expect(reports[0]).toEqual({
			sessionId: "s1",
			data: JSON.stringify([{ what: "containers", n: 1 }]),
			error: undefined,
			force: true,
		});
		expect(reports[1]?.force).toBe(false);
		expect(
			client.messages.some(
				(m) => m.type === "event" && (m.data as { ok: boolean }).ok,
			),
		).toBe(true);

		client.ws.send(JSON.stringify({ type: "refresh", id: "r1" }));
		await waitFor(() => client.messages.some((m) => m.id === "r1"));
		expect(client.messages.find((m) => m.id === "r1")).toEqual({
			type: "result",
			id: "r1",
			ok: true,
			data: null,
		});
		expect(reports.some((r, i) => i > 0 && r.force)).toBe(true);

		client.ws.close();
		await waitFor(() => closed.length === 1);
		const readsAtClose = reads;
		await new Promise((r) => setTimeout(r, 400));
		expect(reads).toBe(readsAtClose);
		await server.close();
	});

	test("an unreachable host is stored as the snapshot's error", async () => {
		const { server, reports } = setup(
			{ "snapshot-token-unreachable": snapshotSession("s2", {}) },
			async () => {
				throw new Error("connect ECONNREFUSED 203.0.113.7:22");
			},
		);
		const port = await server.listening;
		const client = await connect(port, "snapshot-token-unreachable");
		await waitFor(() => reports.length >= 1);
		expect(reports[0]).toEqual({
			sessionId: "s2",
			data: "null",
			error: "connect ECONNREFUSED 203.0.113.7:22",
			force: true,
		});
		await waitFor(() =>
			client.messages.some(
				(m) => m.type === "event" && !(m.data as { ok: boolean }).ok,
			),
		);
		expect(client.ws.readyState).toBe(WebSocket.OPEN);
		client.ws.close();
		await server.close();
	});

	test("a snapshot that needs a job's context is refused", async () => {
		const { server, reports } = setup(
			{
				"snapshot-token-audit-0001": snapshotSession("s3", {
					what: "audit",
				}),
			},
			async () => [],
		);
		const port = await server.listening;
		const client = await connect(port, "snapshot-token-audit-0001");
		const code = await new Promise<number>((resolve) =>
			client.ws.on("close", (c) => resolve(c)),
		);
		expect(code).toBe(1011);
		expect(client.messages).toContainEqual({
			type: "error",
			message: "audit is not kept fresh live",
		});
		expect(reports).toEqual([]);
		await server.close();
	});

	test("two pages on the same host and kind share one reading per interval", async () => {
		let reads = 0;
		const { server, reports } = setup(
			{
				"snapshot-token-viewer-one": snapshotSession("v1", {
					serverId: "srv-shared" as never,
					intervalMs: 300,
				}),
				"snapshot-token-viewer-two": snapshotSession("v2", {
					serverId: "srv-shared" as never,
					intervalMs: 300,
				}),
			},
			async () => {
				reads++;
				await new Promise((r) => setTimeout(r, 20));
				return [];
			},
		);
		const port = await server.listening;
		const one = await connect(port, "snapshot-token-viewer-one");
		const two = await connect(port, "snapshot-token-viewer-two");
		await new Promise((r) => setTimeout(r, 1000));
		one.ws.close();
		two.ws.close();
		// Alone each would read about 4 times in a second (first read plus
		// one per 300 ms); together they share most readings.
		expect(reads).toBeLessThanOrEqual(5);
		expect(reports.filter((r) => !r.force).length).toBeLessThanOrEqual(reads);
		await server.close();
	});
});

describe("snapshot readings", () => {
	test("concurrent readers share one load and a fresh reading is reused", async () => {
		const readings = new SnapshotReadings();
		const unwatch = readings.watch("k");
		let loads = 0;
		const load = async () => {
			loads++;
			await new Promise((r) => setTimeout(r, 20));
			return { data: `"${loads}"`, at: Date.now() };
		};
		const [a, b] = await Promise.all([
			readings.read("k", 0, load),
			readings.read("k", 0, load),
		]);
		expect(loads).toBe(1);
		expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
		expect((await readings.read("k", 10_000, load)).fresh).toBe(false);
		expect(loads).toBe(1);
		expect((await readings.read("k", 0, load)).fresh).toBe(true);
		expect(loads).toBe(2);
		unwatch();
		// Nobody watches: nothing is kept to be reused.
		expect((await readings.read("k", 10_000, load)).fresh).toBe(true);
	});
});
