import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
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

afterEach(() => {
	vi.useRealTimers();
});

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "admin");
	await addMember(t, "org1", "mallory", "member");
	// Members see host-wide Docker views only with this grant.
	await grantMember(t, "org1", "mallory", {
		flags: { canAccessToDocker: true },
	});
	await addMember(t, "org2", "eve", "owner");
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

const sample = (cpu: string) => ({
	cpu,
	memory: { used: "10MiB", total: "1GiB" },
	block: { readMb: 1, writeMb: 2 },
	network: { inputMb: 3, outputMb: 4 },
});

const openAndRedeem = async (
	t: TestConvex,
	user: string,
	request: FunctionArgs<typeof api.live.sessions.open>["request"],
) => {
	const { token, sessionId } = await asUser(t, user).action(
		api.live.sessions.open,
		{ request },
	);
	const agentId = await addAgent(t);
	const agent = asAgent(t, agentId);
	await agent.mutation(api.live.agent.redeem, { token });
	return { sessionId, agent, agentId };
};

describe("monitoring history", () => {
	test("records samples per watched target and serves them to viewers", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const serverId = await createServer(t);
		const request = {
			kind: "containerStats" as const,
			scope: { type: "host" as const, organizationId: "org1", serverId },
			target: { type: "container" as const, containerId: "shop-web-1" },
		};
		const { sessionId, agent } = await openAndRedeem(t, "bob", request);
		expect(
			await agent.mutation(api.live.monitoringHistory.record, {
				sessionId,
				sample: sample("1%"),
			}),
		).toBe(true);
		// A second viewer within the interval doesn't add a row.
		expect(
			await agent.mutation(api.live.monitoringHistory.record, {
				sessionId,
				sample: sample("2%"),
			}),
		).toBe(false);
		vi.advanceTimersByTime(11_000);
		await agent.mutation(api.live.monitoringHistory.record, {
			sessionId,
			sample: sample("3%"),
		});

		const history = await asUser(t, "alice").query(
			api.live.monitoringHistory.history,
			{ request },
		);
		expect(history.map((row) => row.sample.cpu)).toEqual(["1%", "3%"]);

		// Members are restricted, so they never see the admins' history.
		expect(
			await asUser(t, "mallory").query(api.live.monitoringHistory.history, {
				request,
			}),
		).toEqual([]);
		await expect(
			asUser(t, "eve").query(api.live.monitoringHistory.history, { request }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "mallory").query(api.live.monitoringHistory.history, {
				request: { ...request, target: { type: "host" as const } },
			}),
		).rejects.toThrow(/administrator/);

		vi.advanceTimersByTime(25 * 60 * 60 * 1000);
		await t.mutation(internal.live.monitoringHistory.prune, {});
		expect(
			await asUser(t, "alice").query(api.live.monitoringHistory.history, {
				request,
			}),
		).toEqual([]);
	});

	test("only the agent holding an open stats session may record", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const { sessionId, agent } = await openAndRedeem(t, "bob", {
			kind: "containerTerminal",
			scope: { type: "host", organizationId: "org1", serverId },
			containerId: "abc123",
			shell: "bash",
		});
		await expect(
			agent.mutation(api.live.monitoringHistory.record, {
				sessionId,
				sample: sample("1%"),
			}),
		).rejects.toThrow(/Not an open stats session/);
		const stats = await openAndRedeem(t, "bob", {
			kind: "containerStats",
			scope: { type: "host", organizationId: "org1", serverId },
			target: { type: "host" },
		});
		await expect(
			agent.mutation(api.live.monitoringHistory.record, {
				sessionId: stats.sessionId,
				sample: sample("1%"),
			}),
		).rejects.toThrow(/Not an open stats session/);
		await expect(
			asUser(t, "bob").mutation(api.live.monitoringHistory.record, {
				sessionId: stats.sessionId,
				sample: sample("1%"),
			}),
		).rejects.toThrow(/Agent authentication required/);
	});
});

describe("new live requests", () => {
	test("docker events since and service container listings are validated", async () => {
		const t = await seed();
		const serverId = await createServer(t);
		const scope = { type: "host" as const, organizationId: "org1", serverId };
		const open = (request: object) =>
			asUser(t, "mallory").action(api.live.sessions.open, {
				request: request as any,
			});
		await open({ kind: "dockerEvents", scope, sinceMinutes: 60 });
		await expect(
			open({ kind: "dockerEvents", scope, sinceMinutes: 5000 }),
		).rejects.toThrow(/Since/);
		await open({
			kind: "serviceContainers",
			scope,
			appName: "shop-web",
			mode: "swarm",
		});
		await expect(
			open({
				kind: "serviceContainers",
				scope,
				appName: "shop; rm -rf /",
				mode: "native",
			}),
		).rejects.toThrow(/app name/);
		await expect(
			asUser(t, "eve").action(api.live.sessions.open, {
				request: {
					kind: "serviceContainers",
					scope,
					appName: "shop",
					mode: "native",
				},
			}),
		).rejects.toThrow(/Server not found|Not a member/);
	});

	test("compose metrics may pick one of the service's containers", async () => {
		const t = await seed();
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "shop",
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
		});
		const compose = await t.run((ctx) =>
			ctx.db.get("compose", composeId as Id<"compose">),
		);
		await grantMember(t, "org1", "mallory", {
			services: [composeId],
			flags: { canAccessToDocker: true },
		});
		await asUser(t, "alice").action(api.live.monitoring.configure, {
			organizationId: "org1",
			settings: {
				refreshRate: 30,
				port: 4500,
				retentionDays: 2,
				cronJob: "0 0 * * *",
				thresholds: { cpu: 80, memory: 90 },
				containers: { refreshRate: 30, include: [], exclude: [] },
			},
		});
		await asUser(t, "alice").mutation(api.live.monitoring.setup, {
			organizationId: "org1",
		});
		const scope = {
			type: "service" as const,
			serviceKind: "compose" as const,
			serviceId: composeId,
		};
		const { token } = await asUser(t, "mallory").action(
			api.live.sessions.open,
			{
				request: {
					kind: "metrics",
					scope,
					dataPoints: "all",
					containerName: `${compose?.appName}-web-1`,
				},
			},
		);
		const redeemed = await asAgent(t, await addAgent(t)).mutation(
			api.live.agent.redeem,
			{ token },
		);
		expect(redeemed?.extra).toMatchObject({
			type: "metrics",
			appName: `${compose?.appName}-web-1`,
		});
		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, {
				request: {
					kind: "metrics",
					scope,
					dataPoints: 50,
					containerName: "someone-elses-db",
				},
			}),
		).rejects.toThrow(/does not belong/);
		await expect(
			asUser(t, "mallory").action(api.live.sessions.open, {
				request: { kind: "metrics", scope, dataPoints: 20_000 },
			}),
		).rejects.toThrow(/Data points/);
	});
});
