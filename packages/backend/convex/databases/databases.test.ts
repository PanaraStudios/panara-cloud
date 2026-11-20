import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	addServer,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

afterEach(() => {
	vi.useRealTimers();
});

const PASSWORD = "S3cretPassw0rd";

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const { projectId, environmentId } = await asUser(t, "alice").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "shop" },
	);
	return { projectId, environmentId };
};

const createPostgres = async (
	t: TestConvex,
	environmentId: Id<"environments">,
	extra: Record<string, unknown> = {},
) =>
	await asUser(t, "alice").action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "Main DB",
		appName: "main-db",
		databaseName: "shop",
		databaseUser: "shop",
		databasePassword: PASSWORD,
		...extra,
	});

const containsSecret = (value: unknown, secret: string) =>
	JSON.stringify(value).includes(secret);

describe("databases", () => {
	test("create stores credentials encrypted and adds the data volume", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const databaseId = await createPostgres(t, environmentId, {
			dockerImage: "postgres:17",
		});

		const row = await t.run((ctx) => ctx.db.get("databases", databaseId));
		expect(row).toMatchObject({
			organizationId: "org1",
			engine: "postgres",
			databaseName: "shop",
			databaseUser: "shop",
			status: "idle",
		});
		expect(row?.appName).toMatch(/^main-db-[a-z0-9]{6}$/);
		expect(containsSecret(row, PASSWORD)).toBe(false);

		const secrets = await t.run((ctx) => ctx.db.query("secrets").collect());
		expect(secrets.map((s) => s.kind)).toEqual(["databases.password"]);
		expect(containsSecret(secrets, PASSWORD)).toBe(false);

		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const mounts = await asUser(t, "bob").query(
			api.databases.databases.mounts,
			{
				databaseId,
			},
		);
		expect(mounts).toMatchObject([
			{
				type: "volume",
				volumeName: `${row?.appName}-data`,
				mountPath: "/var/lib/postgresql/data",
			},
		]);
	});

	test("engine defaults: postgres 18 path, mysql root password, generated passwords", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const alice = asUser(t, "alice");
		const pg = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "postgres",
			name: "pg",
		});
		const mysql = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "mysql",
			name: "my",
		});
		expect(
			(await alice.query(api.databases.databases.mounts, { databaseId: pg }))[0]
				?.mountPath,
		).toBe("/var/lib/postgresql/18/docker");
		const info = await alice.query(api.databases.databases.connection, {
			databaseId: mysql,
		});
		expect(info?.password).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(info?.rootPassword).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(info?.internalUrl).toBe(
			`mysql://mysql:${info?.password}@${info?.internalHost}:3306/mysql`,
		);
	});

	test("members create with the grant; read without secrets; other orgs see nothing", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		await expect(
			asUser(t, "bob").action(api.databases.databases.create, {
				environmentId,
				engine: "redis",
				name: "cache",
			}),
		).rejects.toThrow(/service\.create/);
		const databaseId = await createPostgres(t, environmentId);
		expect(
			await asUser(t, "bob").query(api.databases.databases.list, {
				environmentId,
			}),
		).toHaveLength(0);
		await expect(
			asUser(t, "bob").query(api.databases.databases.get, { databaseId }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });

		const listed = await asUser(t, "bob").query(api.databases.databases.list, {
			environmentId,
		});
		expect(listed).toHaveLength(1);
		expect(containsSecret(listed, PASSWORD)).toBe(false);

		const asMember = await asUser(t, "bob").query(
			api.databases.databases.connection,
			{ databaseId },
		);
		expect(asMember?.password).toBeNull();
		expect(asMember?.internalUrl).toContain("********");
		expect(containsSecret(asMember, PASSWORD)).toBe(false);

		const asAdmin = await asUser(t, "alice").query(
			api.databases.databases.connection,
			{ databaseId },
		);
		expect(asAdmin?.password).toBe(PASSWORD);
		expect(asAdmin?.internalUrl).toBe(
			`postgresql://shop:${PASSWORD}@${asAdmin?.internalHost}:5432/shop`,
		);

		await expect(
			asUser(t, "eve").query(api.databases.databases.get, { databaseId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "eve").query(api.databases.databases.list, { environmentId }),
		).rejects.toThrow(/Not a member/);
		await asUser(t, "bob").mutation(api.databases.databases.deploy, {
			databaseId,
		});
		expect(
			await asUser(t, "bob").query(api.databases.databases.getEnv, {
				databaseId,
			}),
		).toBe("");
		await expect(
			asUser(t, "bob").mutation(api.databases.databases.update, {
				databaseId,
				name: "renamed",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "bob").mutation(api.databases.databases.remove, { databaseId }),
		).rejects.toThrow(/service\.delete/);

		const { projectId } = await t.run(async (ctx) => {
			const environment = await ctx.db.get("environments", environmentId);
			return { projectId: environment?.projectId as string };
		});
		await grantMember(t, "org1", "bob", {
			projects: [projectId],
			flags: { canCreateServices: true, canDeleteServices: true },
		});
		await expect(
			asUser(t, "bob").action(api.databases.databases.create, {
				environmentId,
				engine: "redis",
				name: "cache",
			}),
		).rejects.toThrow(/Only the instance administrator/);
		const own = await asUser(t, "bob").action(api.databases.databases.create, {
			environmentId,
			serverId: await addServer(t, "org1"),
			engine: "redis",
			name: "cache",
		});
		expect(
			await asUser(t, "bob").query(api.databases.databases.get, {
				databaseId: own,
			}),
		).toMatchObject({ name: "cache" });
		await asUser(t, "bob").mutation(api.databases.databases.update, {
			databaseId,
			name: "renamed",
		});
		await asUser(t, "bob").mutation(api.databases.databases.remove, {
			databaseId,
		});
	});

	test("rejects unsafe identifiers and passwords", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		await expect(
			createPostgres(t, environmentId, { databaseUser: "x'; drop" }),
		).rejects.toThrow(/Database user/);
		await expect(
			createPostgres(t, environmentId, { databasePassword: "has space" }),
		).rejects.toThrow(/not allowed/);
	});

	test("deploy queues a job in the service group plus a deployment row", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const databaseId = await createPostgres(t, environmentId);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const jobId = await asUser(t, "alice").mutation(
			api.databases.databases.deploy,
			{ databaseId },
		);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: "local",
			group: `postgres:${databaseId}`,
			spec: { kind: "databases.deploy", databaseId },
			usesBuildSlot: false,
			idempotent: true,
		});
		const history = await asUser(t, "bob").query(
			api.databases.databases.deployments,
			{ databaseId },
		);
		expect(history).toMatchObject([
			{ jobId, title: "Deploy", status: "queued" },
		]);

		await asUser(t, "alice").mutation(api.databases.databases.stop, {
			databaseId,
		});
		expect(
			await asUser(t, "bob").query(api.databases.databases.deployments, {
				databaseId,
			}),
		).toHaveLength(1);
	});

	test("the agent reads credentials and env only while holding the lease", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const databaseId = await createPostgres(t, environmentId);
		await asUser(t, "alice").action(api.databases.databases.setEnv, {
			databaseId,
			env: "TZ=UTC",
		});
		const jobId = await asUser(t, "alice").mutation(
			api.databases.databases.deploy,
			{ databaseId },
		);
		const agent = asAgent(t, await addAgent(t));
		await expect(
			agent.query(api.databases.agent.getServiceContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			asUser(t, "alice").query(api.databases.agent.getServiceContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Agent authentication/);

		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(jobId);
		const lease = { jobId, leaseId: claim?.leaseId ?? "" };
		const context = await agent.query(
			api.databases.agent.getServiceContext,
			lease,
		);
		expect(context.deploy).toMatchObject({
			env: "TZ=UTC",
			credentials: {
				databaseName: "shop",
				databaseUser: "shop",
				password: PASSWORD,
			},
			mounts: [{ type: "volume" }],
		});
		await agent.mutation(api.databases.agent.reportStatus, {
			...lease,
			status: "done",
		});
		const row = await t.run((ctx) => ctx.db.get("databases", databaseId));
		expect(row?.status).toBe("done");
	});

	test("external ports must be free on the server and trigger a redeploy", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const first = await createPostgres(t, environmentId);
		const second = await createPostgres(t, environmentId);
		const alice = asUser(t, "alice");
		const jobId = await alice.mutation(
			api.databases.databases.saveExternalPort,
			{
				databaseId: first,
				externalPort: 15432,
			},
		);
		expect((await t.run((ctx) => ctx.db.get("jobs", jobId)))?.spec.kind).toBe(
			"databases.deploy",
		);
		await expect(
			alice.mutation(api.databases.databases.saveExternalPort, {
				databaseId: second,
				externalPort: 15432,
			}),
		).rejects.toThrow(/already used/);
		await expect(
			alice.mutation(api.databases.databases.saveExternalPort, {
				databaseId: second,
				externalPort: 70000,
			}),
		).rejects.toThrow(/between 1 and 65535/);
		await alice.mutation(api.databases.databases.saveExternalPort, {
			databaseId: first,
			externalPort: null,
		});
		await alice.mutation(api.databases.databases.saveExternalPort, {
			databaseId: second,
			externalPort: 15432,
		});
	});

	test("remove cascades mounts, secrets, backups and schedules and queues host removal", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { environmentId } = await seed(t);
		const databaseId = await createPostgres(t, environmentId);
		const appName = (await t.run((ctx) => ctx.db.get("databases", databaseId)))
			?.appName;
		const alice = asUser(t, "alice");
		const destinationId = await alice.action(
			api.databases.destinations.create,
			{
				organizationId: "org1",
				name: "s3",
				accessKey: "AK",
				secretAccessKey: "SK",
				bucket: "b",
				region: "us-east-1",
				endpoint: "http://s3",
				additionalFlags: [],
			},
		);
		await alice.mutation(api.databases.backups.create, {
			owner: { kind: "database", id: databaseId },
			databaseType: "postgres",
			database: "shop",
			destinationId,
			cronExpression: "0 3 * * *",
			enabled: true,
			prefix: "daily",
		});
		await alice.mutation(api.databases.volumeBackups.create, {
			owner: { kind: "database", id: databaseId },
			name: "data",
			volumeName: `${appName}-data`,
			prefix: "",
			turnOff: false,
			cronExpression: "0 4 * * *",
			enabled: true,
			destinationId,
		});
		const queuedDeploy = await alice.mutation(api.databases.databases.deploy, {
			databaseId,
		});

		await alice.mutation(api.databases.databases.remove, {
			databaseId,
			deleteVolumes: true,
		});
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			expect(await ctx.db.get("databases", databaseId)).toBeNull();
			expect(await ctx.db.query("mounts").collect()).toHaveLength(0);
			expect(await ctx.db.query("databaseBackups").collect()).toHaveLength(0);
			expect(await ctx.db.query("volumeBackups").collect()).toHaveLength(0);
			const kinds = (await ctx.db.query("secrets").collect()).map(
				(s) => s.kind,
			);
			expect(kinds).toEqual(["databases.destinationSecret"]);
			expect((await ctx.db.get("jobs", queuedDeploy))?.status).toBe(
				"cancelled",
			);
			const pending = (
				await ctx.db.system.query("_scheduled_functions").collect()
			).filter((fn) => fn.state.kind === "pending");
			expect(pending).toHaveLength(0);
			const removal = (await ctx.db.query("jobs").collect()).find(
				(job) => job.spec.kind === "databases.remove",
			);
			expect(removal?.spec).toEqual({
				kind: "databases.remove",
				appName,
				volumeNames: [`${appName}-data`],
			});
		});
	});

	test("environment and server cascades remove databases", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { environmentId } = await seed(t);
		const serverId = await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org1",
				name: "s",
				ipAddress: "10.0.0.9",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const onServer = await createPostgres(t, environmentId, { serverId });
		const local = await createPostgres(t, environmentId);
		await t.mutation(internal.databases.databases.removeForServer, {
			serverId,
		});
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get("databases", onServer))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("databases", local))).not.toBeNull();
		const removals = await t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).filter(
				(job) => job.spec.kind === "databases.remove",
			),
		);
		expect(removals).toHaveLength(0);

		await t.mutation(internal.databases.databases.removeForEnvironment, {
			environmentId,
		});
		expect(await t.run((ctx) => ctx.db.get("databases", local))).toBeNull();
	});

	test("mount wrappers authorize against the owning database", async () => {
		const t = setup();
		const { environmentId } = await seed(t);
		const databaseId = await createPostgres(t, environmentId);
		const mountId = await asUser(t, "alice").mutation(
			api.databases.databases.addDatabaseMount,
			{
				databaseId,
				mount: { type: "bind", hostPath: "/srv/conf", mountPath: "/conf" },
			},
		);
		await expect(
			asUser(t, "eve").mutation(api.databases.databases.removeDatabaseMount, {
				mountId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "bob").mutation(api.databases.databases.removeDatabaseMount, {
				mountId,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		await asUser(t, "bob").mutation(
			api.databases.databases.removeDatabaseMount,
			{ mountId },
		);
	});
});
