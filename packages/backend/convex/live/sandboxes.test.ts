import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
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
	await addMember(t, "org1", "mia", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

const ENV = "API_KEY=very-secret-value";

const createSandbox = async (t: TestConvex, user = "bob") =>
	await asUser(t, user).action(api.live.sandboxes.create, {
		organizationId: "org1",
		template: "python",
		timeoutMs: 60_000,
		envVars: ENV,
	});

const startSandbox = async (t: TestConvex, sandboxId: Id<"sandboxes">) => {
	const agentId = await addAgent(t);
	const agent = asAgent(t, agentId);
	const claim = await agent.mutation(api.agent.claimNext, {});
	if (claim?.spec.kind !== "live.sandboxCreate") {
		throw new Error("expected a sandboxCreate claim");
	}
	const lease = { jobId: claim.jobId, leaseId: claim.leaseId };
	const context = await agent.query(api.live.agent.getSandboxContext, lease);
	expect(context).toMatchObject({
		sandboxId,
		image: "python:3.13-slim",
		user: "1000:1000",
		workdir: "/home/user",
		networkMode: "isolated",
		env: ENV,
	});
	expect(
		await agent.mutation(api.live.agent.reportSandboxStarted, {
			...lease,
			containerId: "c0ffee",
		}),
	).toBe(true);
	await agent.mutation(api.agent.complete, {
		...lease,
		result: { kind: "none" },
	});
	return agent;
};

const jobKinds = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.query("jobs").collect()).map((job) => job.spec.kind),
	);

describe("sandboxes", () => {
	test("templates list the sandbox images for signed-in users", async () => {
		const t = await seed();
		const templates = await asUser(t, "mallory").query(
			api.live.sandboxes.templates,
			{},
		);
		expect(templates.find((entry) => entry.name === "python")).toEqual({
			name: "python",
			image: "python:3.13-slim",
			description: "Python 3.13 (pip available)",
		});
		expect(templates).toHaveLength(11);
		await expect(t.query(api.live.sandboxes.templates, {})).rejects.toThrow();
	});

	test("create keeps env encrypted and queues the container job", async () => {
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		const row = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(row).toMatchObject({
			status: "creating",
			image: "python:3.13-slim",
			createdBy: "bob",
			hasEnv: true,
		});
		const secrets = await t.run((ctx) => ctx.db.query("secrets").collect());
		expect(secrets.map((s) => s.kind)).toEqual(["live.sandboxEnv"]);
		expect(JSON.stringify(secrets)).not.toContain("very-secret-value");
		expect(await jobKinds(t)).toEqual(["live.sandboxCreate"]);

		const listed = await asUser(t, "alice").query(api.live.sandboxes.list, {
			organizationId: "org1",
		});
		expect(listed.map((s) => s._id)).toEqual([sandboxId]);
		expect(JSON.stringify(listed)).not.toContain("very-secret-value");
	});

	test("validates input and refuses other organizations", async () => {
		const t = await seed();
		await expect(
			asUser(t, "mallory").action(api.live.sandboxes.create, {
				organizationId: "org1",
				template: "alpine",
			}),
		).rejects.toThrow(/sandbox\.create/);
		await expect(
			asUser(t, "mallory").query(api.live.sandboxes.list, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/sandbox\.read/);
		await expect(
			asUser(t, "bob").action(api.live.sandboxes.create, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/template or image/);
		await expect(
			asUser(t, "bob").action(api.live.sandboxes.create, {
				organizationId: "org1",
				image: "alpine; rm -rf /",
			}),
		).rejects.toThrow(/image reference/);
		await expect(
			asUser(t, "bob").action(api.live.sandboxes.create, {
				organizationId: "org1",
				template: "alpine",
				workdir: "../etc",
			}),
		).rejects.toThrow(/absolute path/);
		await expect(
			asUser(t, "eve").action(api.live.sandboxes.create, {
				organizationId: "org1",
				template: "alpine",
			}),
		).rejects.toThrow(/Not a member/);
		const { sandboxId } = await createSandbox(t);
		expect(
			await asUser(t, "eve")
				.query(api.live.sandboxes.get, { sandboxId })
				.catch((e: Error) => e.message),
		).toMatch(/Not a member/);
		await expect(
			asUser(t, "eve").action(api.live.sessions.open, {
				request: { kind: "sandbox", sandboxId },
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("sessions need a running sandbox; activity extends the idle timeout", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		await expect(
			asUser(t, "bob").action(api.live.sessions.open, {
				request: { kind: "sandbox", sandboxId },
			}),
		).rejects.toThrow(/Sandbox is creating/);

		const agent = await startSandbox(t, sandboxId);
		const started = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(started).toMatchObject({ status: "running", containerId: "c0ffee" });
		const firstExpiry = started?.expiresAt ?? 0;

		const { token, sessionId } = await asUser(t, "bob").action(
			api.live.sessions.open,
			{ request: { kind: "sandbox", sandboxId } },
		);
		const redeemed = await agent.mutation(api.live.agent.redeem, { token });
		expect(redeemed?.extra).toEqual({
			type: "sandbox",
			sandboxId,
			containerId: "c0ffee",
			user: "1000:1000",
			workdir: "/home/user",
		});

		vi.advanceTimersByTime(30_000);
		expect(
			await agent.mutation(api.live.agent.touchSandbox, { sessionId }),
		).toBe(true);
		const touched = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(touched?.expiresAt).toBeGreaterThanOrEqual(firstExpiry + 29_000);

		// The check scheduled for the old expiry reschedules instead of killing.
		vi.advanceTimersByTime(35_000);
		await t.mutation(internal.live.sandboxes.checkExpiry, { sandboxId });
		expect(
			(await t.run((ctx) => ctx.db.get("sandboxes", sandboxId)))?.status,
		).toBe("running");

		vi.advanceTimersByTime(30_000);
		await t.mutation(internal.live.sandboxes.checkExpiry, { sandboxId });
		const expired = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(expired).toMatchObject({ status: "killed" });
		expect(await jobKinds(t)).toContain("live.sandboxKill");
		expect(
			await agent.mutation(api.live.agent.touchSandbox, { sessionId }),
		).toBe(false);
	});

	test("the scheduled expiry check fires on its own", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		await startSandbox(t, sandboxId);
		vi.advanceTimersByTime(61_000);
		await t.finishInProgressScheduledFunctions();
		vi.runOnlyPendingTimers();
		await t.finishInProgressScheduledFunctions();
		const row = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(row?.status).toBe("killed");
	});

	test("creation stuck for ten minutes becomes an error", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		vi.advanceTimersByTime(10 * 60 * 1000 + 1);
		await t.mutation(internal.live.sandboxes.checkExpiry, { sandboxId });
		const row = await t.run((ctx) => ctx.db.get("sandboxes", sandboxId));
		expect(row).toMatchObject({ status: "error" });
	});

	test("admins kill or remove; members have no sandbox access", async () => {
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		await startSandbox(t, sandboxId);
		await expect(
			asUser(t, "mia").mutation(api.live.sandboxes.kill, { sandboxId }),
		).rejects.toThrow(/sandbox\.create/);
		await asUser(t, "alice").mutation(api.live.sandboxes.updateTimeout, {
			sandboxId,
			timeoutMs: 120_000,
		});
		await asUser(t, "bob").mutation(api.live.sandboxes.kill, {
			sandboxId,
		});
		expect(
			(await t.run((ctx) => ctx.db.get("sandboxes", sandboxId)))?.status,
		).toBe("killed");
		await asUser(t, "alice").mutation(api.live.sandboxes.remove, {
			sandboxId,
		});
		expect(await t.run((ctx) => ctx.db.get("sandboxes", sandboxId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("secrets").collect())).toEqual([]);
		const kinds = await jobKinds(t);
		expect(kinds.filter((k) => k === "live.sandboxKill").length).toBe(2);
		expect(kinds).toContain("live.sandboxSetTimeout");
	});

	test("a sandbox killed while starting reports back so the agent cleans up", async () => {
		const t = await seed();
		const { sandboxId } = await createSandbox(t);
		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");
		await asUser(t, "bob").mutation(api.live.sandboxes.kill, {
			sandboxId,
		});
		expect(
			await agent.mutation(api.live.agent.reportSandboxStarted, {
				jobId: claim.jobId,
				leaseId: claim.leaseId,
				containerId: "late",
			}),
		).toBe(false);
		await expect(
			agent.query(api.live.agent.getSandboxContext, {
				jobId: claim.jobId,
				leaseId: "wrong",
			}),
		).rejects.toThrow(/Lease lost/);
	});
});

describe("monitoring alerts", () => {
	const settings = {
		refreshRate: 30,
		port: 4500,
		retentionDays: 2,
		cronJob: "0 0 * * *",
		thresholds: { cpu: 80, memory: 90 },
		containers: { refreshRate: 30, include: ["app-1"], exclude: [] },
	};

	test("configure is admin-only and the agent context carries the token", async () => {
		const t = await seed();
		await expect(
			asUser(t, "mallory").action(api.live.monitoring.configure, {
				organizationId: "org1",
				settings,
			}),
		).rejects.toThrow(/instance administrator|admin role/);
		await expect(
			asUser(t, "alice").action(api.live.monitoring.configure, {
				organizationId: "org1",
				settings: { ...settings, port: 80 },
			}),
		).rejects.toThrow(/Port/);
		await asUser(t, "alice").action(api.live.monitoring.configure, {
			organizationId: "org1",
			settings,
		});
		const jobId = await asUser(t, "alice").mutation(api.live.monitoring.setup, {
			organizationId: "org1",
		});
		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(jobId);
		const context = await agent.query(api.live.agent.getMonitoringContext, {
			jobId,
			leaseId: claim?.leaseId ?? "",
		});
		expect(context.metricsConfig.server).toMatchObject({
			type: "Panel",
			port: 4500,
			urlCallback: "http://site.test/live/monitoring/alert",
			thresholds: { cpu: 80, memory: 90 },
		});
		expect(context.metricsConfig.server.token).toMatch(/^[0-9a-f]{64}$/);
		const view = await asUser(t, "alice").query(api.live.monitoring.get, {
			organizationId: "org1",
		});
		expect(JSON.stringify(view)).not.toContain(
			context.metricsConfig.server.token,
		);
	});

	test("threshold callbacks dispatch serverThreshold once per cooldown", async () => {
		const t = await seed();
		await asUser(t, "alice").action(api.live.monitoring.configure, {
			organizationId: "org1",
			settings,
		});
		await asUser(t, "alice").mutation(api.live.monitoring.setup, {
			organizationId: "org1",
		});
		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		const context = await agent.query(api.live.agent.getMonitoringContext, {
			jobId: claim?.jobId as Id<"jobs">,
			leaseId: claim?.leaseId ?? "",
		});
		const token = context.metricsConfig.server.token;
		const post = (body: unknown) =>
			t.fetch("/live/monitoring/alert", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const alert = {
			ServerType: "Panel",
			Type: "CPU",
			Value: 93.5,
			Threshold: 80,
			Message: "CPU usage (93.50%) exceeded threshold (80.00%)",
			Timestamp: new Date().toISOString(),
		};
		expect(
			(await post({ json: { ...alert, Token: "nope-nope" } })).status,
		).toBe(401);
		expect(
			(await post({ json: { ...alert, Type: "Disk", Token: token } })).status,
		).toBe(400);
		expect((await post({ json: { ...alert, Token: token } })).status).toBe(200);
		expect((await post({ json: { ...alert, Token: token } })).status).toBe(200);
		const config = await t.run((ctx) =>
			ctx.db.query("monitoringConfigs").first(),
		);
		expect(config?.lastAlerts?.cpu).toBeTypeOf("number");
		const dispatches = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(
			dispatches.filter((f) => f.name.includes("notifications")).length,
		).toBe(1);
	});
});
