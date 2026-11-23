import { describe, expect, test } from "vitest";
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
import { isPanelHostRequest } from "./panel";

// org1 is the first organization, so its owner and admins run the instance.
const setupInstance = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	await addMember(t, "org2", "erin", "member");
	return t;
};

const claim = async (t: TestConvex) => {
	const agent = asAgent(t, await addAgent(t));
	const next = await agent.mutation(api.agent.claimNext, {});
	if (!next) throw new Error("expected a claim");
	return { agent, lease: { jobId: next.jobId, leaseId: next.leaseId } };
};

const addServer = (t: TestConvex, organizationId: string) =>
	t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: "key",
			publicKey: "ssh-ed25519 AAAA test",
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: "web-1",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: true,
		});
	});

describe("panel actions", () => {
	test("instance admins queue panel actions; others can't", async () => {
		const t = await setupInstance();
		const jobId = await asUser(t, "alice").mutation(api.infra.panel.runAction, {
			action: { type: "checkUpdate" },
		});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: "local",
			organizationId: "org1",
			spec: { kind: "infra.panelAction", action: { type: "checkUpdate" } },
		});
		const op = await t.run((ctx) =>
			ctx.db
				.query("infraOps")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique(),
		);
		expect(op?.restricted).toBe(true);
		for (const user of ["mallory", "eve"]) {
			await expect(
				asUser(t, user).mutation(api.infra.panel.runAction, {
					action: { type: "reload" },
				}),
			).rejects.toThrow(/instance administrator/);
		}
		await expect(
			asUser(t, "mallory").query(api.infra.snapshots.opResult, { jobId }),
		).rejects.toThrow();
	});

	test("disabling port 3000 needs a panel domain reached through it", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		const disable = (currentHost?: string) =>
			alice.mutation(api.infra.panel.runAction, {
				action: { type: "setPanelPort", enabled: false },
				currentHost,
			});
		await expect(disable("panel.example.com")).rejects.toThrow(
			/Configure a domain/,
		);
		await alice.mutation(api.infra.webServer.assignDomain, {
			host: "panel.example.com",
			https: false,
			certificateType: "none",
		});
		await expect(disable("10.0.0.1:3000")).rejects.toThrow(
			/Access the panel through panel.example.com/,
		);
		await expect(disable("panel.example.com")).resolves.toBeDefined();
		await expect(
			alice.mutation(api.infra.panel.runAction, {
				action: { type: "setPanelPort", enabled: true },
			}),
		).resolves.toBeDefined();
	});

	test("the last update is reported with its state and the reason it failed", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		expect(await alice.query(api.infra.panel.lastUpdate)).toBe(null);

		await alice.mutation(api.infra.panel.runAction, {
			action: { type: "checkUpdate" },
		});
		expect(await alice.query(api.infra.panel.lastUpdate)).toBe(null);
		const check = await claim(t);
		await check.agent.mutation(api.agent.complete, {
			...check.lease,
			result: { kind: "none" },
		});

		const jobId = await alice.mutation(api.infra.panel.runAction, {
			action: { type: "update" },
		});
		expect(await alice.query(api.infra.panel.lastUpdate)).toMatchObject({
			jobId,
			status: "queued",
			error: null,
		});
		const { agent, lease } = await claim(t);
		expect((await alice.query(api.infra.panel.lastUpdate))?.status).toBe(
			"running",
		);
		await agent.mutation(api.agent.fail, {
			...lease,
			error: "Deploying the functions failed: push refused",
		});
		expect(await alice.query(api.infra.panel.lastUpdate)).toMatchObject({
			jobId,
			status: "failed",
			error: "Deploying the functions failed: push refused",
		});

		// Update checks after it don't hide it; a later update replaces it.
		await alice.mutation(api.infra.panel.runAction, {
			action: { type: "checkUpdate" },
		});
		expect((await alice.query(api.infra.panel.lastUpdate))?.jobId).toBe(jobId);
		const again = await claim(t);
		await again.agent.mutation(api.agent.complete, {
			...again.lease,
			result: { kind: "none" },
		});
		const retry = await alice.mutation(api.infra.panel.runAction, {
			action: { type: "update" },
		});
		const second = await claim(t);
		await second.agent.mutation(api.agent.complete, {
			...second.lease,
			result: { kind: "none" },
		});
		expect(await alice.query(api.infra.panel.lastUpdate)).toMatchObject({
			jobId: retry,
			status: "succeeded",
			error: null,
		});

		for (const user of ["mallory", "eve"]) {
			expect(await asUser(t, user).query(api.infra.panel.lastUpdate)).toBe(
				null,
			);
		}
	});

	test("panel host requests", () => {
		expect(isPanelHostRequest("panel.example.com", "panel.example.com")).toBe(
			true,
		);
		expect(
			isPanelHostRequest("Panel.Example.com:443", "panel.example.com"),
		).toBe(true);
		expect(
			isPanelHostRequest("panel.example.com:3000", "panel.example.com"),
		).toBe(false);
		expect(
			isPanelHostRequest("panel.example.com:8080", "panel.example.com"),
		).toBe(false);
		expect(
			isPanelHostRequest("panel.example.com:80", "panel.example.com"),
		).toBe(true);
		expect(isPanelHostRequest("1.2.3.4", "panel.example.com")).toBe(false);
		expect(isPanelHostRequest(undefined, "panel.example.com")).toBe(false);
	});

	test("monitoring cleanup is panel-host only", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		await expect(
			asUser(t, "alice").mutation(api.infra.docker.cleanup, {
				serverId,
				scope: "monitoring",
			}),
		).rejects.toThrow(/panel host/);
		for (const scope of ["monitoring", "patches"] as const) {
			await asUser(t, "alice").mutation(api.infra.docker.cleanup, { scope });
		}
		await asUser(t, "alice").mutation(api.infra.docker.cleanup, {
			serverId,
			scope: "patches",
		});
		await expect(
			asUser(t, "mallory").mutation(api.infra.docker.cleanup, {
				scope: "patches",
			}),
		).rejects.toThrow(/instance administrator/);
	});
});

describe("public IP", () => {
	test("any member asks; the agent stores the panel host's address", async () => {
		const t = await setupInstance();
		const jobId = await asUser(t, "erin").mutation(
			api.infra.panel.detectPublicIp,
			{ organizationId: "org2" },
		);
		expect(
			await asUser(t, "mallory").mutation(api.infra.panel.detectPublicIp, {
				organizationId: "org1",
			}),
		).toBe(jobId);
		if (!jobId) throw new Error("no job queued");
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: "local",
			organizationId: "org1",
			requestedBy: "erin",
		});
		await expect(
			asUser(t, "erin").mutation(api.infra.panel.detectPublicIp, {
				organizationId: "org1",
			}),
		).rejects.toThrow();

		const { agent, lease } = await claim(t);
		await expect(
			agent.mutation(api.infra.agent.reportPublicIp, {
				...lease,
				ip: "not-an-ip",
			}),
		).rejects.toThrow(/Invalid IP/);
		await agent.mutation(api.infra.agent.reportPublicIp, {
			...lease,
			ip: "203.0.113.7",
		});
		const settings = await asUser(t, "erin").query(api.infra.webServer.get);
		expect(settings.publicIp).toBe("203.0.113.7");

		// A fresh result stands for an hour, except for the instance
		// administrator; nothing more reaches the panel host meanwhile.
		const jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("jobs").collect()).length);
		const queued = await jobs();
		expect(
			await asUser(t, "erin").mutation(api.infra.panel.detectPublicIp, {
				organizationId: "org2",
			}),
		).toBeNull();
		expect(await jobs()).toBe(queued);
		expect(
			await asUser(t, "alice").mutation(api.infra.panel.detectPublicIp, {
				organizationId: "org1",
			}),
		).not.toBeNull();
	});

	test("only infra.publicIp jobs may report it", async () => {
		const t = await setupInstance();
		await asUser(t, "alice").mutation(api.infra.panel.runAction, {
			action: { type: "reload" },
		});
		const { agent, lease } = await claim(t);
		await expect(
			agent.mutation(api.infra.agent.reportPublicIp, {
				...lease,
				ip: "203.0.113.7",
			}),
		).rejects.toThrow(/Not available/);
	});
});

// A compose service named appName that the member was given.
const givenService = async (
	t: TestConvex,
	organizationId: string,
	member: string,
	appName: string,
	serverId?: Id<"servers">,
) => {
	const host = await addServer(t, organizationId);
	const owner = organizationId === "org1" ? "alice" : "eve";
	const { environmentId } = await asUser(t, owner).mutation(
		api.projects.create,
		{ organizationId, name: `p-${appName}` },
	);
	const composeId = await asUser(t, owner).mutation(api.compose.crud.create, {
		environmentId,
		name: appName,
		serverId: host,
	});
	await t.run((ctx) =>
		ctx.db.patch("compose", composeId, { appName, serverId }),
	);
	await grantMember(t, organizationId, member, { services: [composeId] });
};

describe("app container pickers", () => {
	const containerAction = async (t: TestConvex, jobId: Id<"jobs">) => {
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		if (
			job?.spec.kind !== "infra.dockerAction" ||
			job.spec.action.type !== "containerList"
		) {
			throw new Error("expected a containerList job");
		}
		return { job, action: job.spec.action };
	};

	test("members see only their organization's containers on the panel host", async () => {
		const t = await setupInstance();
		await givenService(t, "org2", "erin", "shop-abc");
		await expect(
			asUser(t, "erin").mutation(api.infra.docker.listAppContainers, {
				organizationId: "org2",
				appName: "panara-cloud-convex",
			}),
		).rejects.toThrow(/Service not found/);
		const erinJob = await asUser(t, "erin").mutation(
			api.infra.docker.listAppContainers,
			{ organizationId: "org2", appName: "shop-abc" },
		);
		expect((await containerAction(t, erinJob)).action).toEqual({
			type: "containerList",
			appName: "shop-abc",
			organizationId: "org2",
		});
		expect(
			await asUser(t, "erin").query(api.infra.snapshots.opResult, {
				jobId: erinJob,
			}),
		).toMatchObject({ status: "queued" });

		const aliceJob = await asUser(t, "alice").mutation(
			api.infra.docker.listAppContainers,
			{
				organizationId: "org1",
				appName: "panara-cloud",
				appType: "standalone",
			},
		);
		expect((await containerAction(t, aliceJob)).action).toEqual({
			type: "containerList",
			appName: "panara-cloud",
			appType: "standalone",
		});
		const eveJob = await asUser(t, "eve").mutation(
			api.infra.docker.listAppContainers,
			{
				organizationId: "org2",
				appName: "panara-cloud",
				appType: "standalone",
			},
		);
		expect((await containerAction(t, eveJob)).action.organizationId).toBe(
			"org2",
		);
	});

	test("server ownership and docker.read are enforced", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		await givenService(t, "org1", "mallory", "shop", serverId);
		const jobId = await asUser(t, "mallory").mutation(
			api.infra.docker.listAppContainers,
			{ organizationId: "org1", serverId, appName: "shop", appType: "stack" },
		);
		const { job, action } = await containerAction(t, jobId);
		expect(job.partition).toBe(serverId);
		expect(action.organizationId).toBeUndefined();
		await expect(
			asUser(t, "eve").mutation(api.infra.docker.listAppContainers, {
				organizationId: "org2",
				serverId,
				appName: "shop",
			}),
		).rejects.toThrow(/Server not found/);
		await expect(
			asUser(t, "mallory").mutation(api.infra.docker.listAppContainers, {
				organizationId: "org1",
				appName: "shop",
				appType: "swarm",
			}),
		).rejects.toThrow(/docker.read/);
		await expect(
			asUser(t, "eve").mutation(api.infra.docker.listAppContainers, {
				organizationId: "org1",
				appName: "shop",
			}),
		).rejects.toThrow();
		await expect(
			asUser(t, "alice").mutation(api.infra.docker.listAppContainers, {
				organizationId: "org1",
				appName: "shop;rm",
			}),
		).rejects.toThrow(/Invalid app name/);
	});
});

describe("server status and setup scripts", () => {
	test("inactive servers refuse updates, setup and validation", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		const alice = asUser(t, "alice");
		await expect(
			asUser(t, "mallory").mutation(api.servers.setStatus, {
				serverId,
				serverStatus: "inactive",
			}),
		).rejects.toThrow(/server.create/);
		await expect(
			asUser(t, "eve").mutation(api.servers.setStatus, {
				serverId,
				serverStatus: "inactive",
			}),
		).rejects.toThrow();
		await alice.mutation(api.servers.setStatus, {
			serverId,
			serverStatus: "inactive",
		});
		expect(
			(await alice.query(api.servers.get, { serverId }))?.serverStatus,
		).toBe("inactive");
		await expect(
			alice.mutation(api.infra.setup.run, { serverId }),
		).rejects.toThrow(/inactive/);
		await expect(
			alice.mutation(api.servers.validate, { serverId }),
		).rejects.toThrow(/inactive/);
		await alice.mutation(api.servers.setStatus, {
			serverId,
			serverStatus: "active",
		});
		await alice.mutation(api.servers.validate, { serverId });
	});

	test("a custom script replaces the default one in setup", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		const alice = asUser(t, "alice");
		expect(await alice.query(api.servers.getSetupScript, { serverId })).toBe(
			null,
		);
		await alice.mutation(api.servers.setSetupScript, {
			serverId,
			script: "set -e\necho custom",
		});
		expect(await alice.query(api.servers.getSetupScript, { serverId })).toBe(
			"set -e\necho custom",
		);
		await expect(
			asUser(t, "eve").query(api.servers.getSetupScript, { serverId }),
		).rejects.toThrow();
		await expect(
			asUser(t, "mallory").mutation(api.servers.setSetupScript, {
				serverId,
				script: "x",
			}),
		).rejects.toThrow(/server.create/);

		await alice.mutation(api.infra.setup.run, { serverId });
		const { agent, lease } = await claim(t);
		expect(
			(await agent.query(api.infra.agent.getSetupContext, lease)).customScript,
		).toBe("set -e\necho custom");

		await alice.mutation(api.servers.setSetupScript, { serverId, script: " " });
		expect(await alice.query(api.servers.getSetupScript, { serverId })).toBe(
			null,
		);
	});

	test("the default script comes from the agent", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		const jobId = await asUser(t, "alice").mutation(
			api.servers.requestDefaultSetupScript,
			{ serverId },
		);
		const { agent, lease } = await claim(t);
		expect(lease.jobId).toBe(jobId);
		expect(
			await agent.query(api.infra.agent.getSetupScriptContext, lease),
		).toEqual({ serverType: "deploy", advertiseAddr: "10.0.0.5" });
		await expect(
			asUser(t, "eve").mutation(api.servers.requestDefaultSetupScript, {
				serverId,
			}),
		).rejects.toThrow();
	});

	test("removing a server drops its custom script", async () => {
		const t = await setupInstance();
		const serverId = await addServer(t, "org1");
		await asUser(t, "alice").mutation(api.servers.setSetupScript, {
			serverId,
			script: "echo hi",
		});
		await asUser(t, "alice").mutation(api.servers.remove, { serverId });
		await t.finishAllScheduledFunctions(() => {});
		expect(
			await t.run((ctx) => ctx.db.query("serverSetupScripts").collect()),
		).toHaveLength(0);
	});
});

describe("server connect command", () => {
	const generate = (t: TestConvex, user = "alice", organizationId = "org1") =>
		asUser(t, user).action(api.infra.connectNode.generateCommand, {
			organizationId,
			name: "Hetzner box",
			description: "db host",
			serverType: "deploy",
		});

	test("the script authorizes the key and registers the server once", async () => {
		const t = await setupInstance();
		const { token, sshKeyId, expiresAt } = await generate(t);
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect(
			await asUser(t, "alice").query(api.infra.connect.status, { sshKeyId }),
		).toBeNull();

		const script = await t.fetch(`/infra/connect/${token}`, {
			headers: {
				"x-panara-cloud-connect-url": `https://panel.example.com/api/connect/${token}`,
			},
		});
		expect(script.status).toBe(200);
		const body = await script.text();
		const key = await t.run((ctx) => ctx.db.get("sshKeys", sshKeyId));
		expect(body).toContain(key?.publicKey ?? "missing");
		expect(body).toContain(`https://panel.example.com/api/connect/${token}`);

		const register = await t.fetch(`/infra/connect/${token}`, {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
		});
		expect(register.status).toBe(200);
		expect(await register.text()).toContain(
			'Server "Hetzner box" is connected',
		);
		const connected = await asUser(t, "alice").query(api.infra.connect.status, {
			sshKeyId,
		});
		expect(connected).toMatchObject({
			name: "Hetzner box",
			ipAddress: "198.51.100.4",
		});
		const server = await t.run((ctx) =>
			ctx.db.get("servers", connected?.serverId as Id<"servers">),
		);
		expect(server).toMatchObject({
			organizationId: "org1",
			username: "root",
			port: 22,
			sshKeyId,
			serverStatus: "active",
			description: "db host",
			enableDockerCleanup: false,
		});
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			0,
		);

		const again = await t.fetch(`/infra/connect/${token}`, {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.4" },
		});
		expect(again.status).toBe(409);
		const reused = await t.fetch(`/infra/connect/${token}`);
		expect(await reused.text()).toContain("already used");
	});

	test("a deactivated creator's command no longer registers", async () => {
		const t = await setupInstance();
		const { token } = await generate(t);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query("memberships").collect();
			for (const row of rows.filter((m) => m.userId === "alice")) {
				await ctx.db.patch("memberships", row._id, { deactivated: true });
			}
		});
		const response = await t.fetch(`/infra/connect/${token}`, {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.4" },
		});
		expect(response.status).toBe(403);
		expect(
			await t.run((ctx) => ctx.db.query("servers").collect()),
		).toHaveLength(0);
	});

	test("setup=true queues the server setup", async () => {
		const t = await setupInstance();
		const { token } = await generate(t);
		const response = await t.fetch(`/infra/connect/${token}?setup=true`, {
			method: "POST",
			headers: { "cf-connecting-ip": "198.51.100.9" },
		});
		expect(response.status).toBe(200);
		const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
		expect(jobs.map((job) => job.spec.kind)).toEqual(["infra.serverSetup"]);
		expect(jobs[0]?.requestedBy).toBe("alice");
	});

	test("bad, expired and revoked tokens", async () => {
		const t = await setupInstance();
		const bogus = await t.fetch("/infra/connect/not-a-real-token-at-all");
		expect(await bogus.text()).toContain("not valid");
		expect(
			(
				await t.fetch("/infra/connect/not-a-real-token-at-all", {
					method: "POST",
					headers: { "x-forwarded-for": "198.51.100.4" },
				})
			).status,
		).toBe(400);

		const { token } = await generate(t);
		const noIp = await t.fetch(`/infra/connect/${token}`, { method: "POST" });
		expect(noIp.status).toBe(400);

		await t.run(async (ctx) => {
			const row = await ctx.db.query("serverConnectTokens").first();
			if (row) {
				await ctx.db.patch("serverConnectTokens", row._id, {
					expiresAt: Date.now() - 1,
				});
			}
		});
		const expired = await t.fetch(`/infra/connect/${token}`, {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.4" },
		});
		expect(expired.status).toBe(410);
		await t.mutation(internal.infra.connect.expireTokens, {});
		expect(
			await t.run((ctx) => ctx.db.query("serverConnectTokens").collect()),
		).toHaveLength(0);

		const second = await generate(t);
		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("memberships")
				.withIndex("by_organizationId_and_userId", (q) =>
					q.eq("organizationId", "org1").eq("userId", "alice"),
				)
				.unique();
			if (membership) {
				await ctx.db.patch("memberships", membership._id, { role: "member" });
			}
		});
		const revoked = await t.fetch(`/infra/connect/${second.token}`, {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.4" },
		});
		expect(revoked.status).toBe(403);
	});

	test("only users who may create servers generate commands", async () => {
		const t = await setupInstance();
		await expect(generate(t, "mallory")).rejects.toThrow(/server.create/);
		await expect(generate(t, "eve", "org1")).rejects.toThrow();
		const { sshKeyId } = await generate(t);
		await expect(
			asUser(t, "eve").query(api.infra.connect.status, { sshKeyId }),
		).rejects.toThrow();
	});
});
