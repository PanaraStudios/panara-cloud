import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const createServer = (
	t: TestConvex,
	organizationId: string,
	ip: string,
	serverType: "deploy" | "build" = "deploy",
) =>
	t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: "key",
			publicKey: "ssh-ed25519 AAAA",
		});
		await ctx.db.insert("secrets", {
			organizationId,
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			...(await encryptSecret(`KEY-${ip}`)),
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: `server-${ip}`,
			ipAddress: ip,
			port: 22,
			username: "root",
			sshKeyId,
			serverType,
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		});
	});

const addNetwork = (
	t: TestConvex,
	serverId: Id<"servers"> | undefined,
	name: string,
	driver: "overlay" | "bridge" = "overlay",
	organizationId = "org1",
) =>
	t.run((ctx) =>
		ctx.db.insert("networks", {
			organizationId,
			serverId,
			name,
			driver,
			internal: false,
			attachable: true,
			enableIPv4: true,
			enableIPv6: false,
			status: "created",
		}),
	);

const PASSWORD = "S3cretPassw0rd";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const source = await createServer(t, "org1", "10.0.0.1");
	const target = await createServer(t, "org1", "10.0.0.2");
	const create = (engine: "postgres" | "mysql" | "redis", name: string) =>
		alice.action(api.databases.databases.create, {
			environmentId,
			serverId: source,
			engine,
			name,
			databasePassword: PASSWORD,
			databaseRootPassword: engine === "mysql" ? PASSWORD : undefined,
		});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, source, target, create, agent };
};

const claim = async (agent: ReturnType<typeof asAgent>, kind: string) => {
	for (let i = 0; i < 50; i++) {
		const next = await agent.mutation(api.agent.claimNext, {});
		if (!next) break;
		const lease = { jobId: next.jobId, leaseId: next.leaseId };
		if (next.spec.kind === kind) return lease;
		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
	}
	throw new Error(`No ${kind} job queued`);
};

const secretsText = (t: TestConvex) =>
	t.run(async (ctx) =>
		JSON.stringify([
			await ctx.db.query("secrets").collect(),
			await ctx.db.query("databases").collect(),
			await ctx.db.query("jobs").collect(),
		]),
	);

describe("database transfer", () => {
	test("checks authorization and external ports on the target", async () => {
		const { t, alice, source, target, create } = await seed();
		const databaseId = await create("postgres", "main");
		await expect(
			asUser(t, "mallory").mutation(api.databases.transfer.start, {
				databaseId,
				targetServerId: target,
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "eve").mutation(api.databases.transfer.start, {
				databaseId,
				targetServerId: target,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.mutation(api.databases.transfer.start, {
				databaseId,
				targetServerId: source,
			}),
		).rejects.toThrow(/already on the selected server/);
		await t.run((ctx) =>
			ctx.db.patch("databases", databaseId, { externalPort: 15432 }),
		);
		await t.run(async (ctx) => {
			const other = await ctx.db.get("databases", databaseId);
			if (!other) throw new Error("missing");
			const { _id, _creationTime, ...fields } = other;
			await ctx.db.insert("databases", {
				...fields,
				appName: "other-db",
				serverId: target,
			});
		});
		await expect(
			alice.mutation(api.databases.transfer.start, {
				databaseId,
				targetServerId: target,
			}),
		).rejects.toThrow(/15432 .* on server-10.0.0.2/);
	});

	test("copies volumes, switches servers and deploys on the target", async () => {
		const { t, alice, target, create, agent } = await seed();
		const databaseId = await create("postgres", "main");
		await alice.mutation(api.databases.transfer.start, {
			databaseId,
			targetServerId: target,
		});
		const lease = await claim(agent, "databases.transfer");
		const context = await agent.query(
			api.databases.agent.getTransferContext,
			lease,
		);
		expect(context?.volumes).toHaveLength(1);
		expect(context?.volumes[0]).toMatch(/^postgres-[a-z0-9]{6}-data$/);
		expect(context).toMatchObject({ target: { host: "10.0.0.2" } });
		await agent.mutation(api.databases.agent.completeTransfer, lease);
		const row = await t.run((ctx) => ctx.db.get("databases", databaseId));
		expect(row?.serverId).toBe(target);
		const deploy = await t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).find(
				(job) => job.spec.kind === "databases.deploy",
			),
		);
		expect(deploy?.partition).toBe(target);
	});
});

describe("database password change", () => {
	test("needs service.create; the new password is stored only after the container accepted it", async () => {
		const { t, alice, create, agent } = await seed();
		const databaseId = await create("postgres", "main");
		const NEW = "N3wPassw0rd-x";
		await expect(
			asUser(t, "mallory").action(api.databases.passwords.changePassword, {
				databaseId,
				password: NEW,
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "eve").action(api.databases.passwords.changePassword, {
				databaseId,
				password: NEW,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.action(api.databases.passwords.changePassword, {
				databaseId,
				password: "bad'quote",
			}),
		).rejects.toThrow(/not allowed/);
		await expect(
			alice.action(api.databases.passwords.changePassword, {
				databaseId,
				password: NEW,
				user: "root",
			}),
		).rejects.toThrow(/no separate root password/);

		await alice.action(api.databases.passwords.changePassword, {
			databaseId,
			password: NEW,
		});
		expect(await secretsText(t)).not.toContain(NEW);
		const lease = await claim(agent, "databases.changePassword");
		const context = await agent.query(
			api.databases.agent.getPasswordChangeContext,
			lease,
		);
		expect(context).toMatchObject({
			engine: "postgres",
			user: "user",
			newPassword: NEW,
			credentials: { password: PASSWORD },
		});
		const connection = () =>
			alice.query(api.databases.databases.connection, { databaseId });
		expect((await connection())?.password).toBe(PASSWORD);
		await agent.mutation(api.databases.agent.reportPasswordChange, {
			...lease,
			ok: true,
		});
		expect((await connection())?.password).toBe(NEW);
		await grantMember(t, "org1", "mallory", { services: [databaseId] });
		expect(
			(
				await asUser(t, "mallory").query(api.databases.databases.connection, {
					databaseId,
				})
			)?.password,
		).toBeNull();
		expect(await secretsText(t)).not.toContain(NEW);
		const kinds = await t.run(async (ctx) =>
			(await ctx.db.query("secrets").collect()).map((s) => s.kind),
		);
		expect(kinds).not.toContain("databases.pendingPassword");
	});

	test("a failed change keeps the old password; redis is redeployed after success", async () => {
		const { t, alice, create, agent } = await seed();
		const pg = await create("postgres", "main");
		await alice.action(api.databases.passwords.changePassword, {
			databaseId: pg,
			password: "Another1",
		});
		const failed = await claim(agent, "databases.changePassword");
		await agent.mutation(api.databases.agent.reportPasswordChange, {
			...failed,
			ok: false,
		});
		expect(
			(
				await alice.query(api.databases.databases.connection, {
					databaseId: pg,
				})
			)?.password,
		).toBe(PASSWORD);
		await agent.mutation(api.agent.fail, { ...failed, error: "x" });

		const redis = await create("redis", "cache");
		await alice.action(api.databases.passwords.changePassword, {
			databaseId: redis,
			password: "Another2",
		});
		const lease = await claim(agent, "databases.changePassword");
		await agent.mutation(api.databases.agent.reportPasswordChange, {
			...lease,
			ok: true,
		});
		const deploys = await t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).filter(
				(job) =>
					job.spec.kind === "databases.deploy" && job.spec.databaseId === redis,
			),
		);
		expect(deploys).toHaveLength(1);
	});

	test("mysql root password changes are allowed", async () => {
		const { alice, create, agent } = await seed();
		const databaseId = await create("mysql", "my");
		await alice.action(api.databases.passwords.changePassword, {
			databaseId,
			password: "Root-Pass1",
			user: "root",
		});
		const lease = await claim(agent, "databases.changePassword");
		await agent.mutation(api.databases.agent.reportPasswordChange, {
			...lease,
			ok: true,
		});
		const connection = await alice.query(api.databases.databases.connection, {
			databaseId,
		});
		expect(connection).toMatchObject({
			password: PASSWORD,
			rootPassword: "Root-Pass1",
		});
	});
});

describe("database networks", () => {
	test("validated networks reach the deploy context", async () => {
		const { t, alice, source, create, agent } = await seed();
		const databaseId = await create("postgres", "main");
		const edge = await addNetwork(t, source, "edge");
		const bridge = await addNetwork(t, source, "local", "bridge");
		await expect(
			alice.mutation(api.databases.databases.updateNetworks, {
				databaseId,
				networkIds: [bridge],
				detachPanaraCloudNetwork: false,
			}),
		).rejects.toThrow(/overlay/);
		await expect(
			asUser(t, "mallory").mutation(api.databases.databases.updateNetworks, {
				databaseId,
				networkIds: [edge],
				detachPanaraCloudNetwork: false,
			}),
		).rejects.toThrow(/service\.create/);
		await alice.mutation(api.databases.databases.updateNetworks, {
			databaseId,
			networkIds: [edge],
			detachPanaraCloudNetwork: false,
		});
		await alice.mutation(api.databases.databases.deploy, { databaseId });
		const lease = await claim(agent, "databases.deploy");
		const context = await agent.query(
			api.databases.agent.getServiceContext,
			lease,
		);
		expect(context.deploy?.networkSwarm).toEqual([
			{ Target: "panara-cloud-network" },
			{ Target: "edge" },
		]);
		expect(context.deploy).not.toHaveProperty("networkIds");
	});
});
