import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { LIVE_SNAPSHOT_REWRITE_MS } from "./agent";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const sshKeyId = await asUser(t, "alice").action(api.sshKeys.create, {
		organizationId: "org1",
		name: "key",
		publicKey: "ssh-ed25519 AAAAC3Nza test",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	const serverId = await asUser(t, "alice").mutation(api.servers.create, {
		organizationId: "org1",
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup: false,
	});
	const agentId = await addAgent(t);
	return { t, serverId, agent: asAgent(t, agentId) };
};

const snapshotRequest = (
	serverId: Id<"servers"> | undefined,
	what: "containers" | "images" | "audit" = "containers",
	intervalMs = 10_000,
) => ({ kind: "hostSnapshot" as const, serverId, what, intervalMs });

const openSession = async (
	t: TestConvex,
	agent: ReturnType<typeof asAgent>,
	userId: string,
	request: ReturnType<typeof snapshotRequest>,
) => {
	const { token, sessionId } = await asUser(t, userId).action(
		api.live.sessions.open,
		{ request },
	);
	await agent.mutation(api.live.agent.redeem, { token });
	return sessionId;
};

const counts = (t: TestConvex) =>
	t.run(async (ctx) => ({
		jobs: (await ctx.db.query("jobs").take(1000)).length,
		logChunks: (await ctx.db.query("jobLogChunks").take(1000)).length,
		snapshots: (await ctx.db.query("infraSnapshots").take(1000)).length,
	}));

describe("host snapshot sessions", () => {
	test("keep the snapshot row fresh without creating jobs", async () => {
		const { t, serverId, agent } = await seed();
		const sessionId = await openSession(
			t,
			agent,
			"alice",
			snapshotRequest(serverId),
		);
		const containers = JSON.stringify([{ containerId: "c1", name: "/web" }]);
		expect(
			await agent.mutation(api.infra.agent.reportLiveSnapshot, {
				sessionId,
				data: containers,
				force: true,
			}),
		).toBe(true);
		const snapshot = await asUser(t, "alice").query(api.infra.snapshots.get, {
			serverId,
			kind: "containers",
		});
		expect(snapshot).toMatchObject({
			data: containers,
			error: null,
			pendingJobId: null,
		});
		// The same reading again soon after is not rewritten; a forced one is.
		expect(
			await agent.mutation(api.infra.agent.reportLiveSnapshot, {
				sessionId,
				data: containers,
			}),
		).toBe(false);
		expect(
			await agent.mutation(api.infra.agent.reportLiveSnapshot, {
				sessionId,
				data: containers,
				force: true,
			}),
		).toBe(true);
		expect(await counts(t)).toEqual({ jobs: 0, logChunks: 0, snapshots: 1 });
	});

	test("an unchanged reading is rewritten once a minute; a change at once", async () => {
		vi.useFakeTimers();
		try {
			const { t, serverId, agent } = await seed();
			const sessionId = await openSession(
				t,
				agent,
				"alice",
				snapshotRequest(serverId),
			);
			const report = (data: string, error?: string) =>
				agent.mutation(api.infra.agent.reportLiveSnapshot, {
					sessionId,
					data,
					error,
				});
			expect(await report("[]")).toBe(true);
			vi.advanceTimersByTime(10_000);
			expect(await report("[]")).toBe(false);
			expect(await report('[{"containerId":"c2"}]')).toBe(true);
			vi.advanceTimersByTime(LIVE_SNAPSHOT_REWRITE_MS);
			expect(await report('[{"containerId":"c2"}]')).toBe(true);
			// An error keeps the last good data next to it, once.
			expect(await report("null", "connect ECONNREFUSED")).toBe(true);
			expect(await report("null", "connect ECONNREFUSED")).toBe(false);
			const row = await asUser(t, "alice").query(api.infra.snapshots.get, {
				serverId,
				kind: "containers",
			});
			expect(row).toMatchObject({
				data: '[{"containerId":"c2"}]',
				error: "connect ECONNREFUSED",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("are authorized like reading the snapshot", async () => {
		const { t, serverId } = await seed();
		const open = (
			userId: string,
			request: ReturnType<typeof snapshotRequest>,
		) => asUser(t, userId).action(api.live.sessions.open, { request });
		await expect(open("eve", snapshotRequest(serverId))).rejects.toThrow(
			/Not a member/,
		);
		// Members read the containers snapshot, but images need docker.read.
		await expect(
			open("mallory", snapshotRequest(serverId)),
		).resolves.toMatchObject({
			path: expect.stringMatching(/^\/live\?token=/),
		});
		await expect(
			open("mallory", snapshotRequest(serverId, "images")),
		).rejects.toThrow();
		await grantMember(t, "org1", "mallory", {
			flags: { canAccessToDocker: true },
		});
		await expect(
			open("mallory", snapshotRequest(serverId, "images")),
		).resolves.toBeTruthy();
		// The panel host is for instance administrators.
		await expect(open("mallory", snapshotRequest(undefined))).rejects.toThrow();
		await expect(
			open("alice", snapshotRequest(undefined)),
		).resolves.toBeTruthy();
	});

	test("only Docker listings, at a bounded interval", async () => {
		const { t, serverId } = await seed();
		const open = (request: ReturnType<typeof snapshotRequest>) =>
			asUser(t, "alice").action(api.live.sessions.open, { request });
		await expect(open(snapshotRequest(serverId, "audit"))).rejects.toThrow(
			/not kept fresh live/,
		);
		await expect(
			open(snapshotRequest(serverId, "containers", 1000)),
		).rejects.toThrow(/interval/);
		await expect(
			open(snapshotRequest(serverId, "containers", 3_600_000)),
		).rejects.toThrow(/interval/);
	});

	test("only the agent holding the open session writes, and only its snapshot", async () => {
		const { t, serverId, agent } = await seed();
		const { token, sessionId } = await asUser(t, "alice").action(
			api.live.sessions.open,
			{ request: snapshotRequest(serverId) },
		);
		const report = (who: ReturnType<typeof asAgent>) =>
			who.mutation(api.infra.agent.reportLiveSnapshot, {
				sessionId,
				data: "[]",
			});
		// Not redeemed yet.
		await expect(report(agent)).rejects.toThrow(/Not an open snapshot session/);
		await agent.mutation(api.live.agent.redeem, { token });
		const other = asAgent(t, await addAgent(t));
		await expect(report(other)).rejects.toThrow(/Not an open snapshot session/);
		await expect(
			asUser(t, "alice").mutation(api.infra.agent.reportLiveSnapshot, {
				sessionId,
				data: "[]",
			}),
		).rejects.toThrow();
		await agent.mutation(api.live.agent.closed, {
			sessionId,
			reason: "client closed",
		});
		await expect(report(agent)).rejects.toThrow(/Not an open snapshot session/);

		const second = await openSession(t, agent, "alice", {
			...snapshotRequest(serverId),
		});
		await agent.mutation(api.infra.agent.reportLiveSnapshot, {
			sessionId: second,
			data: "[]",
		});
		const rows = await t.run((ctx) => ctx.db.query("infraSnapshots").take(10));
		expect(rows.map((row) => [row.serverId, row.kind])).toEqual([
			[serverId, "containers"],
		]);
	});
});
