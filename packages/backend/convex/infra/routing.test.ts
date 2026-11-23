import { describe, expect, test } from "vitest";
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
import {
	loadRoutingSnapshot,
	registerRoutingOwner,
	removeRoutingOwner,
} from "./routing";

const app = { kind: "application" as const, id: "app1" };

const createServer = async (t: TestConvex, organizationId = "org1") =>
	(await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId,
			name: "web",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: true,
		}),
	)) as Id<"servers">;

const registerApp = (
	t: TestConvex,
	serverId: Id<"servers"> | undefined,
	owner: { kind: "application" | "compose" | "preview"; id: string } = app,
	extra: Partial<Parameters<typeof registerRoutingOwner>[1]> = {},
) =>
	t.run((ctx) =>
		registerRoutingOwner(ctx, {
			organizationId: "org1",
			owner,
			serverId,
			appName: `app-${owner.id}`,
			...extra,
		}),
	);

const domainInput = {
	host: "app.example.com",
	https: true,
	certificateType: "letsencrypt" as const,
	port: 3000,
};

const routingJobs = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.query("jobs").collect()).filter((job) =>
			job.spec.kind.startsWith("infra.routing"),
		),
	);

const setupOrg = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const serverId = await createServer(t);
	await registerApp(t, serverId);
	return { t, serverId };
};

describe("domains", () => {
	test("admins create domains and a routing sync is queued on the owner's server", async () => {
		const { t, serverId } = await setupOrg();
		const alice = asUser(t, "alice");
		const domainId = await alice.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
		});
		const domain = await alice.query(api.infra.domains.get, { domainId });
		expect(domain).toMatchObject({
			host: "app.example.com",
			path: "/",
			internalPath: "/",
			serverId,
			enabled: true,
		});
		await alice.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
			host: "www.example.com",
		});
		const jobs = await routingJobs(t);
		// The second change collapses into the sync that is still queued.
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			partition: serverId,
			group: "application:app1",
			spec: { kind: "infra.routingSync", owner: app },
			idempotent: true,
		});
	});

	test("members manage the domains of services they were given; other organizations see nothing", async () => {
		const { t } = await setupOrg();
		const domainId = await asUser(t, "alice").mutation(
			api.infra.domains.create,
			{ owner: app, ...domainInput },
		);
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.infra.domains.listByOwner, { owner: app }),
		).rejects.toThrow(/access to this service/);
		await expect(
			mallory.mutation(api.infra.domains.create, {
				owner: app,
				...domainInput,
				host: "x.example.com",
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			mallory.mutation(api.infra.domains.remove, { domainId }),
		).rejects.toThrow(/access to this service/);

		await grantMember(t, "org1", "mallory", { services: [app.id] });
		expect(
			await mallory.query(api.infra.domains.listByOwner, { owner: app }),
		).toHaveLength(1);
		const created = await mallory.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
			host: "x.example.com",
		});
		await mallory.mutation(api.infra.domains.setEnabled, {
			domainId: created,
			enabled: false,
		});
		await mallory.mutation(api.infra.domains.remove, { domainId: created });
		expect(
			await mallory.query(api.infra.domains.listByOwner, { owner: app }),
		).toHaveLength(1);

		const eve = asUser(t, "eve");
		await expect(
			eve.query(api.infra.domains.listByOwner, { owner: app }),
		).rejects.toThrow(/Not a member/);
		await expect(
			eve.query(api.infra.domains.get, { domainId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			eve.mutation(api.infra.domains.update, {
				domainId,
				...domainInput,
				host: "stolen.example.com",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.query(api.infra.domains.listByOwner, { owner: app }),
		).rejects.toThrow(/Not authenticated/);
	});

	test("host + path is unique per server, across owners", async () => {
		const { t, serverId } = await setupOrg();
		const other = { kind: "application" as const, id: "app2" };
		await registerApp(t, serverId, other);
		const alice = asUser(t, "alice");
		await alice.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
		});
		await expect(
			alice.mutation(api.infra.domains.create, {
				owner: other,
				...domainInput,
				host: "APP.example.com",
			}),
		).rejects.toThrow(/already used/);
		await alice.mutation(api.infra.domains.create, {
			owner: other,
			...domainInput,
			path: "/api",
		});
		const elsewhere = { kind: "application" as const, id: "app3" };
		await registerApp(t, await createServer(t), elsewhere);
		await alice.mutation(api.infra.domains.create, {
			owner: elsewhere,
			...domainInput,
		});
	});

	test("validates hosts, paths, certificates and compose services", async () => {
		const { t, serverId } = await setupOrg();
		const alice = asUser(t, "alice");
		const create = (fields: Record<string, unknown>) =>
			alice.mutation(api.infra.domains.create, {
				owner: app,
				...domainInput,
				...fields,
			});
		await expect(create({ host: "bad_host.com" })).rejects.toThrow(
			/Invalid domain/,
		);
		await expect(create({ host: " spaced.com" })).rejects.toThrow(/spaces/);
		await expect(create({ path: "/a b" })).rejects.toThrow(/Path/);
		await expect(create({ stripPath: true })).rejects.toThrow(/Strip path/);
		await expect(create({ certificateType: "custom" })).rejects.toThrow(
			/resolver/,
		);
		await expect(create({ port: 70000 })).rejects.toThrow(/Port/);
		await expect(create({ middlewares: ["ok", "bad name"] })).rejects.toThrow(
			/middleware/,
		);

		const compose = { kind: "compose" as const, id: "c1" };
		await registerApp(t, serverId, compose, { composeType: "stack" });
		await expect(
			alice.mutation(api.infra.domains.create, {
				owner: compose,
				...domainInput,
			}),
		).rejects.toThrow(/Service name/);
		await alice.mutation(api.infra.domains.create, {
			owner: compose,
			...domainInput,
			serviceName: "web",
		});
		// Compose routing is applied by labels on deploy, not by a sync job.
		expect(
			(await routingJobs(t)).filter((j) => j.group === "compose:c1"),
		).toHaveLength(0);
	});
});

describe("routing snapshot and lifecycle", () => {
	test("the agent holding the lease gets the full routing snapshot", async () => {
		const { t } = await setupOrg();
		const alice = asUser(t, "alice");
		await alice.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
			path: "/api",
			stripPath: true,
		});
		await alice.mutation(api.infra.redirects.create, {
			owner: app,
			regex: "^https://www\\.(.*)",
			replacement: "https://$1",
			permanent: true,
		});
		await alice.action(api.infra.basicAuth.create, {
			owner: app,
			username: "admin",
			password: "hunter2",
		});
		const users = await alice.query(api.infra.basicAuth.listByOwner, {
			owner: app,
		});
		expect(users).toEqual([expect.objectContaining({ username: "admin" })]);
		expect(JSON.stringify(users)).not.toContain("apr1");

		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		const claim = await agent.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");
		expect(claim.spec).toEqual({ kind: "infra.routingSync", owner: app });
		const snapshot = await agent.query(api.infra.agent.getRoutingSnapshot, {
			jobId: claim.jobId,
			leaseId: claim.leaseId,
		});
		expect(snapshot).toMatchObject({
			appName: "app-app1",
			domains: [
				{ host: "app.example.com", path: "/api", stripPath: true, https: true },
			],
			redirects: [{ regex: "^https://www\\.(.*)", permanent: true }],
			basicAuth: [{ username: "admin" }],
		});
		expect(snapshot?.basicAuth[0]?.passwordHash).toMatch(/^\$apr1\$.{8}\$/);
		expect(JSON.stringify(snapshot)).not.toContain("hunter2");

		await expect(
			agent.query(api.infra.agent.getRoutingSnapshot, {
				jobId: claim.jobId,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			alice.query(api.infra.agent.getRoutingSnapshot, {
				jobId: claim.jobId,
				leaseId: claim.leaseId,
			}),
		).rejects.toThrow(/Agent authentication required/);
		// A lease for a routing job can't read other kinds of context.
		await expect(
			agent.query(api.infra.agent.getCertificate, {
				jobId: claim.jobId,
				leaseId: claim.leaseId,
			}),
		).rejects.toThrow(/Not available/);
	});

	test("previews route with their application's basic auth and no redirects", async () => {
		const { t, serverId } = await setupOrg();
		const preview = { kind: "preview" as const, id: "p1" };
		await registerApp(t, serverId, preview, { parent: app });
		const alice = asUser(t, "alice");
		await alice.mutation(api.infra.domains.create, {
			owner: preview,
			...domainInput,
			host: "pr-1.example.com",
		});
		await alice.mutation(api.infra.redirects.create, {
			owner: app,
			regex: "^/old",
			replacement: "/new",
			permanent: false,
		});
		await t.run(async (ctx) => {
			for (const job of await ctx.db.query("jobs").collect()) {
				await ctx.db.delete("jobs", job._id);
			}
		});
		await alice.action(api.infra.basicAuth.create, {
			owner: app,
			username: "u",
			password: "p",
		});
		expect((await routingJobs(t)).map((j) => j.group).sort()).toEqual([
			"application:app1",
			"preview:p1",
		]);
		const snapshot = await t.run((ctx) => loadRoutingSnapshot(ctx, preview));
		expect(snapshot?.redirects).toEqual([]);
		expect(snapshot?.basicAuth.map((u) => u.username)).toEqual(["u"]);
	});

	test("moving an owner re-homes its domains; removing it cascades", async () => {
		const { t, serverId } = await setupOrg();
		const alice = asUser(t, "alice");
		await alice.mutation(api.infra.domains.create, {
			owner: app,
			...domainInput,
		});
		await alice.mutation(api.infra.ports.create, {
			owner: app,
			publishedPort: 8443,
			targetPort: 443,
			protocol: "tcp",
			publishMode: "host",
		});
		const newServer = await createServer(t);
		await registerApp(t, newServer);
		const [domain] = await alice.query(api.infra.domains.listByOwner, {
			owner: app,
		});
		expect(domain?.serverId).toBe(newServer);
		const jobs = await routingJobs(t);
		expect(
			jobs.some(
				(j) =>
					j.spec.kind === "infra.routingRemove" &&
					j.partition === serverId &&
					j.spec.appName === "app-app1",
			),
		).toBe(true);

		// The host is taken on the old server by another app now.
		const squatter = { kind: "application" as const, id: "app9" };
		await registerApp(t, serverId, squatter);
		await alice.mutation(api.infra.domains.create, {
			owner: squatter,
			...domainInput,
		});
		await expect(registerApp(t, serverId)).rejects.toThrow(/already used/);

		await t.run((ctx) => removeRoutingOwner(ctx, app));
		await t.finishAllScheduledFunctions(() => {});
		const leftovers = await t.run(async (ctx) => ({
			domains: (await ctx.db.query("domains").collect()).filter(
				(d) => d.owner.id === "app1",
			),
			ports: await ctx.db.query("ports").collect(),
		}));
		expect(leftovers).toEqual({ domains: [], ports: [] });
		await expect(
			alice.query(api.infra.domains.listByOwner, { owner: app }),
		).rejects.toThrow(/Service not found/);
	});

	test("published ports are unique per server and protocol", async () => {
		const { t, serverId } = await setupOrg();
		const other = { kind: "application" as const, id: "app2" };
		await registerApp(t, serverId, other);
		const alice = asUser(t, "alice");
		const port = {
			publishedPort: 5432,
			targetPort: 5432,
			protocol: "tcp" as const,
			publishMode: "host" as const,
		};
		await alice.mutation(api.infra.ports.create, { owner: app, ...port });
		await expect(
			alice.mutation(api.infra.ports.create, { owner: other, ...port }),
		).rejects.toThrow(/already published/);
		await alice.mutation(api.infra.ports.create, {
			owner: other,
			...port,
			protocol: "udp",
		});
	});
});
