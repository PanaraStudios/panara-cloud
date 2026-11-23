import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { type LiveRequest, validateRequest } from "./lib";
import { revokeLiveSessions } from "./revoke";

afterEach(() => {
	vi.useRealTimers();
});

// org1 is the first organization, so its owner/admins administer the panel host.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "admin");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	await addMember(t, "org2", "trent", "admin");
	return t;
};

const createServer = async (t: TestConvex) => {
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "key",
		publicKey: "ssh-ed25519 AAAAC3Nza test",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	return await alice.mutation(api.servers.create, {
		organizationId: "org1",
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup: false,
	});
};

const createDatabase = async (t: TestConvex) => {
	const { environmentId } = await asUser(t, "alice").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "shop" },
	);
	return await asUser(t, "alice").action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "Main DB",
		appName: "main-db",
		databaseName: "shop",
		databaseUser: "shop",
		databasePassword: "S3cretPassw0rd",
	});
};

const agentOf = async (t: TestConvex) => asAgent(t, await addAgent(t));

describe("session creation", () => {
	test("host terminals need an admin of the server's organization", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const request = {
			kind: "hostTerminal" as const,
			organizationId: "org1",
			serverId,
		};
		const opened = await asUser(t, "bob").action(api.live.sessions.open, {
			request,
		});
		expect(opened.token.length).toBeGreaterThanOrEqual(40);
		expect(opened.path).toBe(`/live?token=${opened.token}`);

		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, { request }),
		).rejects.toThrow(/admin role/);
		await expect(
			asUser(t, "eve").action(api.live.sessions.open, { request }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "eve").action(api.live.sessions.open, {
				request: { ...request, organizationId: "org2" },
			}),
		).rejects.toThrow(/Server not found/);
	});

	test("the panel host terminal is limited to instance admins", async () => {
		const t = await seed();
		await asUser(t, "alice").action(api.live.sessions.open, {
			request: {
				kind: "hostTerminal",
				organizationId: "org1",
				local: { username: "deploy", port: 22 },
			},
		});
		await expect(
			asUser(t, "trent").action(api.live.sessions.open, {
				request: { kind: "hostTerminal", organizationId: "org2" },
			}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "alice").action(api.live.sessions.open, {
				request: {
					kind: "hostTerminal",
					organizationId: "org1",
					local: { username: "root; rm -rf /", port: 22 },
				},
			}),
		).rejects.toThrow(/Invalid username/);
	});

	test("only the token hash is stored", async () => {
		const t = await seed();
		const { token, sessionId } = await asUser(t, "alice").action(
			api.live.sessions.open,
			{ request: { kind: "hostTerminal", organizationId: "org1" } },
		);
		const row = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(JSON.stringify(row)).not.toContain(token);
		expect(row).toMatchObject({ status: "pending", userId: "alice" });
	});

	test("service scope restricts containers to the service; other orgs are refused", async () => {
		const t = await seed();
		const databaseId = await createDatabase(t);
		const scope = {
			type: "service" as const,
			serviceKind: "database" as const,
			serviceId: databaseId,
		};
		const terminal = {
			kind: "containerTerminal" as const,
			scope,
			containerId: "main-db-abc123.1.xyz",
			shell: "sh" as const,
		};
		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, {
				request: terminal,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "mallory", { services: [databaseId] });
		const { sessionId } = await asUser(t, "mallory").action(
			api.live.sessions.open,
			{
				request: {
					kind: "containerTerminal",
					scope,
					containerId: "main-db-abc123.1.xyz",
					shell: "sh",
				},
			},
		);
		const row = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(row?.restriction).toEqual({
			organizationId: "org1",
			serviceId: databaseId,
		});
		expect(row?.partition).toBe("local");

		await asUser(t, "mallory").action(api.live.sessions.open, {
			request: {
				kind: "containerLogs",
				scope,
				containerId: "abc",
				runType: "native",
				tail: 100,
				since: "all",
				timestamps: true,
			},
		});
		await expect(
			asUser(t, "eve").action(api.live.sessions.open, {
				request: {
					kind: "containerLogs",
					scope,
					containerId: "abc",
					runType: "native",
					tail: 100,
					since: "all",
					timestamps: true,
				},
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("host scope: admins are unrestricted, members only reach their organization", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const open = (user: string, organizationId: string) =>
			asUser(t, user).action(api.live.sessions.open, {
				request: {
					kind: "dockerEvents",
					scope: { type: "host", organizationId, serverId },
				},
			});
		const admin = await open("bob", "org1");
		await expect(open("mallory", "org1")).rejects.toThrow(/docker\.read/);
		await grantMember(t, "org1", "mallory", {
			flags: { canAccessToDocker: true },
		});
		const member = await open("mallory", "org1");
		const rows = await t.run(async (ctx) => [
			await ctx.db.get("liveSessions", admin.sessionId),
			await ctx.db.get("liveSessions", member.sessionId),
		]);
		expect(rows[0]?.restriction).toBeUndefined();
		expect(rows[1]?.restriction).toEqual({ organizationId: "org1" });
		await expect(open("eve", "org2")).rejects.toThrow(/Server not found/);

		// Panel host: an admin of another organization is still restricted.
		const local = await asUser(t, "trent").action(api.live.sessions.open, {
			request: {
				kind: "dockerEvents",
				scope: { type: "host", organizationId: "org2" },
			},
		});
		const localRow = await t.run((ctx) =>
			ctx.db.get("liveSessions", local.sessionId),
		);
		expect(localRow?.restriction).toEqual({ organizationId: "org2" });
		await expect(
			asUser(t, "trent").action(api.live.sessions.open, {
				request: {
					kind: "containerStats",
					scope: { type: "host", organizationId: "org2" },
					target: { type: "host" },
				},
			}),
		).rejects.toThrow(/administrator/);
	});

	test("rejects unsafe log parameters", async () => {
		const t = await seed();
		const base = {
			kind: "containerLogs" as const,
			scope: { type: "host" as const, organizationId: "org1" },
			containerId: "abc",
			runType: "native" as const,
			tail: 100,
			since: "all",
			timestamps: false,
		};
		const open = (patch: Record<string, unknown>) =>
			asUser(t, "alice").action(api.live.sessions.open, {
				request: { ...base, ...patch },
			});
		await expect(open({ containerId: "a;b" })).rejects.toThrow(/container ID/);
		await expect(open({ tail: 20_000 })).rejects.toThrow(/Tail/);
		await expect(open({ since: "1h; ls" })).rejects.toThrow(/since/);
		await expect(open({ search: "a\nb" })).rejects.toThrow(/Search/);
		await open({ since: "15m", search: "GET /api?q=$(id)" });
	});
});

describe("redemption", () => {
	test("is single-use and only for agents", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const { token, sessionId } = await asUser(t, "bob").action(
			api.live.sessions.open,
			{
				request: {
					kind: "containerTerminal",
					scope: { type: "host", organizationId: "org1", serverId },
					containerId: "abc123",
					shell: "bash",
				},
			},
		);
		await expect(
			asUser(t, "bob").mutation(api.live.agent.redeem, { token }),
		).rejects.toThrow(/Agent authentication required/);

		const agent = await agentOf(t);
		const redeemed = await agent.mutation(api.live.agent.redeem, { token });
		expect(redeemed).toMatchObject({
			sessionId,
			organizationId: "org1",
			restriction: null,
			request: { kind: "containerTerminal", containerId: "abc123" },
			target: { type: "ssh", host: "10.0.0.5", username: "root" },
		});
		await expect(
			agent.mutation(api.live.agent.redeem, { token }),
		).rejects.toThrow(/Invalid or used token/);
		await expect(
			agent.mutation(api.live.agent.redeem, { token: `${token}x` }),
		).rejects.toThrow(/Invalid or used token/);
	});

	test("expires a minute after creation", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const { token, sessionId } = await asUser(t, "alice").action(
			api.live.sessions.open,
			{ request: { kind: "hostTerminal", organizationId: "org1" } },
		);
		vi.advanceTimersByTime(61_000);
		const agent = await agentOf(t);
		expect(await agent.mutation(api.live.agent.redeem, { token })).toBeNull();
		const row = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(row).toMatchObject({ status: "closed", closeReason: "expired" });
		await expect(
			agent.mutation(api.live.agent.redeem, { token }),
		).rejects.toThrow(/Invalid or used token/);
	});

	test("local host terminal returns the login from the session", async () => {
		const t = await seed();
		const { token } = await asUser(t, "alice").action(api.live.sessions.open, {
			request: {
				kind: "hostTerminal",
				organizationId: "org1",
				local: { username: "deploy", port: 2222 },
			},
		});
		const redeemed = await (await agentOf(t)).mutation(api.live.agent.redeem, {
			token,
		});
		expect(redeemed).toMatchObject({
			target: { type: "local" },
			extra: {
				type: "hostTerminal",
				local: { username: "deploy", port: 2222 },
			},
		});
	});
});

describe("kill and close", () => {
	test("owner or admin kills; the agent sees the request and closes", async () => {
		const t = await seed();
		await grantMember(t, "org1", "mallory", {
			flags: { canAccessToDocker: true },
		});
		const { token, sessionId } = await asUser(t, "mallory").action(
			api.live.sessions.open,
			{
				request: {
					kind: "dockerEvents",
					scope: { type: "host", organizationId: "org1" },
				},
			},
		);
		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		await agent.mutation(api.live.agent.redeem, { token });

		await expect(
			asUser(t, "eve").mutation(api.live.sessions.kill, { sessionId }),
		).rejects.toThrow(/Not a member/);
		const listed = await asUser(t, "bob").query(api.live.sessions.listOpen, {
			organizationId: "org1",
		});
		expect(listed.map((s) => s.sessionId)).toEqual([sessionId]);
		expect(JSON.stringify(listed)).not.toContain("tokenHash");

		await asUser(t, "bob").mutation(api.live.sessions.kill, { sessionId });
		expect(await agent.query(api.live.agent.killRequests, {})).toEqual([
			sessionId,
		]);
		const other = asAgent(t, await addAgent(t));
		expect(await other.query(api.live.agent.killRequests, {})).toEqual([]);
		await expect(
			other.mutation(api.live.agent.closed, { sessionId, reason: "x" }),
		).rejects.toThrow(/Session not found/);

		await agent.mutation(api.live.agent.closed, {
			sessionId,
			reason: "client closed",
		});
		const row = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(row).toMatchObject({ status: "closed", closeReason: "killed" });
		expect(await agent.query(api.live.agent.killRequests, {})).toEqual([]);
	});

	test("members can't kill other users' sessions; agent restart closes its sessions", async () => {
		const t = await seed();
		const { token, sessionId } = await asUser(t, "bob").action(
			api.live.sessions.open,
			{ request: { kind: "hostTerminal", organizationId: "org1" } },
		);
		await expect(
			asUser(t, "mallory").mutation(api.live.sessions.kill, { sessionId }),
		).rejects.toThrow(/Not your session/);
		const agent = await agentOf(t);
		await agent.mutation(api.live.agent.redeem, { token });
		expect(await agent.mutation(api.live.agent.resetSessions, {})).toBe(1);
		const row = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(row).toMatchObject({
			status: "closed",
			closeReason: "agent restarted",
		});
	});

	test("caps concurrent sessions per user", async () => {
		const t = await seed();
		for (let i = 0; i < 20; i++) {
			await asUser(t, "alice").action(api.live.sessions.open, {
				request: { kind: "hostTerminal", organizationId: "org1" },
			});
		}
		await expect(
			asUser(t, "alice").action(api.live.sessions.open, {
				request: { kind: "hostTerminal", organizationId: "org1" },
			}),
		).rejects.toThrow(/Too many/);
	});
});

describe("metrics and access log", () => {
	test("metrics need monitoring set up; access log needs an admin", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const request = {
			kind: "metrics" as const,
			scope: { type: "host" as const, organizationId: "org1", serverId },
			dataPoints: 50,
		};
		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, { request }),
		).rejects.toThrow(/not set up/);
		await asUser(t, "bob").action(api.live.monitoring.configure, {
			organizationId: "org1",
			serverId,
			settings: {
				refreshRate: 30,
				port: 4500,
				retentionDays: 2,
				cronJob: "0 0 * * *",
				thresholds: { cpu: 80, memory: 90 },
				containers: { refreshRate: 30, include: [], exclude: [] },
			},
		});
		await asUser(t, "bob").mutation(api.live.monitoring.setup, {
			organizationId: "org1",
			serverId,
		});
		const { token } = await asUser(t, "mallory").action(
			api.live.sessions.open,
			{ request },
		);
		const redeemed = await (await agentOf(t)).mutation(api.live.agent.redeem, {
			token,
		});
		expect(redeemed?.extra).toMatchObject({ type: "metrics", port: 4500 });
		expect((redeemed?.extra as { token: string }).token).toMatch(
			/^[0-9a-f]{64}$/,
		);

		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, {
				request: { kind: "accessLog", organizationId: "org1", serverId },
			}),
		).rejects.toThrow(/admin role/);
		await asUser(t, "bob").action(api.live.sessions.open, {
			request: { kind: "accessLog", organizationId: "org1", serverId },
		});
	});

	test("a metrics window is bounded, and reaches the agent as asked", async () => {
		const host = { type: "host" as const, organizationId: "org1" };
		const day = 86_400;
		const from = 1_790_000_000;
		const metrics = (
			window: { from: number; to: number; step: number },
			extra: Partial<Extract<LiveRequest, { kind: "metrics" }>> = {},
		): LiveRequest => ({
			kind: "metrics",
			scope: host,
			dataPoints: 10_000,
			window,
			...extra,
		});
		// 30 days in two-hour buckets, a week in half hours, the largest answer.
		for (const window of [
			{ from, to: from + 30 * day, step: 7200 },
			{ from: from + 0.5, to: from + 7 * day, step: 1800 },
			{ from, to: from + 2000 * 60, step: 60 },
			{ from, to: from + 365 * day, step: 30 * day },
		]) {
			expect(() => validateRequest(metrics(window))).not.toThrow();
		}
		const refused: [{ from: number; to: number; step: number }, RegExp][] = [
			[{ from, to: from, step: 60 }, /earlier to a later/],
			[{ from: from + day, to: from, step: 60 }, /earlier to a later/],
			[{ from, to: from + 401 * day, step: day }, /earlier to a later/],
			[{ from: Number.NaN, to: from, step: 60 }, /Unix seconds/],
			[{ from, to: Number.POSITIVE_INFINITY, step: 60 }, /Unix seconds/],
			[{ from: -1, to: from, step: 60 }, /Unix seconds/],
			[{ from, to: from + day, step: 0 }, /whole number of seconds/],
			[{ from, to: from + day, step: 90.5 }, /whole number of seconds/],
			[{ from, to: from + day, step: -60 }, /whole number of seconds/],
			[{ from, to: from + 365 * day, step: 31 * day }, /whole number/],
			[{ from, to: from + 30 * day, step: 60 }, /at most 2000 buckets/],
			[{ from, to: from + 2000 * 60 + 1, step: 60 }, /at most 2000 buckets/],
		];
		for (const [window, message] of refused) {
			expect(() => validateRequest(metrics(window))).toThrow(message);
		}
		// Only the host's own metrics are kept per reading in the collector.
		const window = { from, to: from + day, step: 300 };
		expect(() =>
			validateRequest(metrics(window, { containerName: "web-1" })),
		).toThrow(/host metrics only/);
		expect(() =>
			validateRequest(
				metrics(window, {
					scope: {
						type: "service",
						serviceKind: "application",
						serviceId: "x",
					},
				}),
			),
		).toThrow(/host metrics only/);
		// Without a window nothing changes for the callers there are today.
		expect(() =>
			validateRequest({ kind: "metrics", scope: host, dataPoints: 10_000 }),
		).not.toThrow();
		expect(() =>
			validateRequest({ kind: "metrics", scope: host, dataPoints: 10_001 }),
		).toThrow(/between 1 and 10000/);

		const t = await seed();
		const serverId = await createServer(t);
		await asUser(t, "bob").action(api.live.monitoring.configure, {
			organizationId: "org1",
			serverId,
			settings: {
				refreshRate: 60,
				port: 4500,
				retentionDays: 30,
				cronJob: "0 0 * * *",
				thresholds: { cpu: 0, memory: 0 },
				containers: { refreshRate: 60, include: [], exclude: [] },
			},
		});
		await asUser(t, "bob").mutation(api.live.monitoring.setup, {
			organizationId: "org1",
			serverId,
		});
		const scope = { ...host, serverId };
		await expect(
			asUser(t, "bob").action(api.live.sessions.open, {
				request: {
					kind: "metrics",
					scope,
					dataPoints: 10_000,
					window: { from, to: from + 30 * day, step: 60 },
				},
			}),
		).rejects.toThrow(/at most 2000 buckets/);
		const { token } = await asUser(t, "bob").action(api.live.sessions.open, {
			request: {
				kind: "metrics",
				scope,
				dataPoints: 10_000,
				window: { from, to: from + 30 * day, step: 7200 },
			},
		});
		const redeemed = await (await agentOf(t)).mutation(api.live.agent.redeem, {
			token,
		});
		expect(redeemed?.request).toMatchObject({
			kind: "metrics",
			dataPoints: 10_000,
			window: { from, to: from + 30 * day, step: 7200 },
		});
	});
});

describe("expired pending sessions", () => {
	test("don't count towards the cap and don't hide live ones from a revoke", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const request = {
			kind: "accessLog" as const,
			organizationId: "org1",
		};
		const open = () =>
			asUser(t, "bob").action(api.live.sessions.open, { request });
		// Opened and never connected; the cron closes them only every 15
		// minutes.
		for (let i = 0; i < 20; i++) await open();
		await expect(open()).rejects.toThrow(/Too many open live sessions/);
		vi.advanceTimersByTime(2 * 60 * 1000);
		// More expired ones than a revoke reads in one go.
		await t.run(async (ctx) => {
			for (let i = 0; i < 210; i++) {
				await ctx.db.insert("liveSessions", {
					organizationId: "org1",
					userId: "bob",
					kind: "accessLog",
					partition: "local",
					tokenHash: `expired-${i}`,
					status: "pending",
					request,
					connectBy: Date.now() - 1000,
					killRequested: false,
				});
			}
		});
		const { sessionId } = await open();
		await t.run(async (ctx) => {
			await revokeLiveSessions(ctx, { userId: "bob" });
		});
		const session = await t.run((ctx) => ctx.db.get("liveSessions", sessionId));
		expect(session?.status).toBe("closed");
	});
});
