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

const at = (iso: string) => new Date(iso).getTime();
const SECRET_KEY = "minio-secret-key-123";

const destinationArgs = {
	name: "minio",
	provider: "Minio",
	accessKey: "minio-access",
	bucket: "backups",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: ["--s3-sign-accept-encoding=false"],
};

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "shop",
	});
	const databaseId = await alice.action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "Main DB",
		databaseName: "shop",
		databaseUser: "shop",
		databasePassword: "pgpass",
	});
	await grantMember(t, "org1", "bob", { services: [databaseId] });
	const destinationId = await alice.action(api.databases.destinations.create, {
		organizationId: "org1",
		...destinationArgs,
		secretAccessKey: SECRET_KEY,
	});
	return { environmentId, databaseId, destinationId };
};

const backupArgs = (
	databaseId: Id<"databases">,
	destinationId: Id<"destinations">,
) => ({
	owner: { kind: "database" as const, id: databaseId },
	databaseType: "postgres" as const,
	database: "shop",
	destinationId,
	cronExpression: "0 9 * * *",
	timezone: "America/New_York",
	enabled: true,
	prefix: "/daily/",
	keepLatestCount: 3,
});

describe("destinations", () => {
	test("the secret key is encrypted and never returned", async () => {
		const t = setup();
		const { destinationId } = await seed(t);
		const listed = await asUser(t, "bob").query(
			api.databases.destinations.list,
			{
				organizationId: "org1",
			},
		);
		expect(listed).toMatchObject([{ _id: destinationId, bucket: "backups" }]);
		expect(JSON.stringify(listed)).not.toContain(SECRET_KEY);
		const secrets = await t.run((ctx) => ctx.db.query("secrets").collect());
		expect(JSON.stringify(secrets)).not.toContain(SECRET_KEY);
		await expect(
			asUser(t, "eve").query(api.databases.destinations.get, { destinationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "bob").action(api.databases.destinations.create, {
				organizationId: "org1",
				...destinationArgs,
				secretAccessKey: "x",
			}),
		).rejects.toThrow(/destination\.create/);
		await expect(
			asUser(t, "alice").action(api.databases.destinations.create, {
				organizationId: "org1",
				...destinationArgs,
				additionalFlags: ["--x; rm -rf /"],
				secretAccessKey: "x",
			}),
		).rejects.toThrow(/Invalid rclone flag/);
	});

	test("a draft connection test hands the agent the key once, then drops it", async () => {
		const t = setup();
		await seed(t);
		const { opId, jobId } = await asUser(t, "alice").action(
			api.databases.destinations.testConnection,
			{
				organizationId: "org1",
				draft: { ...destinationArgs, secretAccessKey: "draft-key" },
			},
		);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toEqual({ kind: "databases.testDestination", opId });
		expect(JSON.stringify(job)).not.toContain("draft-key");

		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		const lease = { jobId, leaseId: claim?.leaseId ?? "" };
		const context = await agent.query(api.databases.agent.getOpContext, lease);
		expect(context).toMatchObject({
			kind: "testDestination",
			destination: { bucket: "backups", secretAccessKey: "draft-key" },
		});
		await agent.mutation(api.databases.agent.reportOp, {
			...lease,
			result: JSON.stringify({ ok: true }),
		});
		expect(
			await asUser(t, "bob").query(api.databases.destinations.opResult, {
				opId,
			}),
		).toMatchObject({ done: true, result: { ok: true } });
		const kinds = await t.run(async (ctx) =>
			(await ctx.db.query("secrets").collect()).map((s) => s.kind),
		);
		expect(kinds).not.toContain("databases.destinationDraft");
		await expect(
			asUser(t, "eve").query(api.databases.destinations.opResult, { opId }),
		).rejects.toThrow(/Not a member/);
	});

	test("removing a destination removes its backups", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		await asUser(t, "alice").mutation(
			api.databases.backups.create,
			backupArgs(databaseId, destinationId),
		);
		await asUser(t, "alice").mutation(api.databases.destinations.remove, {
			destinationId,
		});
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
		expect(
			await t.run((ctx) => ctx.db.query("databaseBackups").collect()),
		).toHaveLength(0);
	});
});

describe("database backups", () => {
	test("schedules the next run in the backup's timezone and runs on time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T13:59:00Z"));
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		const backupId = await asUser(t, "alice").mutation(
			api.databases.backups.create,
			backupArgs(databaseId, destinationId),
		);
		const created = await asUser(t, "bob").query(api.databases.backups.get, {
			backupId,
		});
		// 9:00 in New York is 14:00Z in January.
		expect(created?.nextRunAt).toBe(at("2026-01-15T14:00:00Z"));
		expect(created).not.toHaveProperty("scheduledFunctionId");

		vi.advanceTimersByTime(61_000);
		await t.finishInProgressScheduledFunctions();
		const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			group: `postgres:${databaseId}`,
			spec: { kind: "databases.backupRun", backupId },
			idempotent: false,
		});
		const after = await t.run((ctx) => ctx.db.get("databaseBackups", backupId));
		expect(after?.nextRunAt).toBe(at("2026-01-16T14:00:00Z"));
		const runs = await asUser(t, "bob").query(api.databases.backups.runs, {
			backupId,
		});
		expect(runs).toMatchObject([
			{ jobId: jobs[0]._id, description: "Scheduled backup", status: "queued" },
		]);

		// A still-queued run is not duplicated by the next tick.
		vi.setSystemTime(at("2026-01-16T14:00:01Z"));
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			1,
		);
	});

	test("reconcile restores lost runs and is idempotent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T08:00:00Z"));
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		await alice.mutation(
			api.databases.backups.create,
			backupArgs(databaseId, destinationId),
		);
		await alice.mutation(api.databases.volumeBackups.create, {
			owner: { kind: "database", id: databaseId },
			name: "data",
			volumeName: "pg-data",
			prefix: "",
			turnOff: true,
			cronExpression: "30 2 * * *",
			enabled: true,
			destinationId,
		});
		await t.run(async (ctx) => {
			for (const fn of await ctx.db.system
				.query("_scheduled_functions")
				.collect()) {
				await ctx.scheduler.cancel(fn._id);
			}
		});

		expect(
			await t.mutation(internal.databases.backups.reconcileBackups, {}),
		).toEqual({ rescheduled: 1, isDone: true });
		expect(
			await t.mutation(internal.databases.backups.reconcileBackups, {}),
		).toEqual({ rescheduled: 0, isDone: true });
		expect(
			await t.mutation(
				internal.databases.volumeBackups.reconcileVolumeBackups,
				{},
			),
		).toEqual({ rescheduled: 1, isDone: true });
		expect(
			await t.mutation(
				internal.databases.volumeBackups.reconcileVolumeBackups,
				{},
			),
		).toEqual({ rescheduled: 0, isDone: true });
		const pending = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect())
				.filter((fn) => fn.state.kind === "pending")
				.map((fn) => fn.scheduledTime)
				.sort(),
		);
		expect(pending).toEqual([
			at("2026-01-15T14:00:00Z"),
			at("2026-01-16T02:30:00Z"),
		]);
	});

	test("disabling cancels the pending run and a stale fire is a no-op", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		const backupId = await asUser(t, "alice").mutation(
			api.databases.backups.create,
			backupArgs(databaseId, destinationId),
		);
		const before = await t.run((ctx) =>
			ctx.db.get("databaseBackups", backupId),
		);
		await asUser(t, "alice").mutation(api.databases.backups.setEnabled, {
			backupId,
			enabled: false,
		});
		await t.mutation(internal.databases.backups.fire, {
			backupId,
			generation: before?.generation ?? 0,
		});
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			0,
		);
		const after = await t.run((ctx) => ctx.db.get("databaseBackups", backupId));
		expect(after?.nextRunAt).toBeUndefined();
	});

	test("validates owner, engine, destination, schedule and retention", async () => {
		const t = setup();
		const { environmentId, databaseId, destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const base = backupArgs(databaseId, destinationId);
		await grantMember(t, "org1", "bob", { services: [] });
		await expect(
			asUser(t, "bob").mutation(api.databases.backups.create, base),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const memberBackupId = await asUser(t, "bob").mutation(
			api.databases.backups.create,
			base,
		);
		await asUser(t, "bob").mutation(api.databases.backups.remove, {
			backupId: memberBackupId,
		});
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				databaseType: "mysql",
			}),
		).rejects.toThrow(/does not match/);
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				cronExpression: "every day",
			}),
		).rejects.toThrow(/Invalid cron/);
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				keepLatestCount: -1,
			}),
		).rejects.toThrow(/Keep latest/);
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				prefix: "../other",
			}),
		).rejects.toThrow(/prefix may only contain/);
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				owner: { kind: "compose", id: "missing" },
				serviceName: "db",
			}),
		).rejects.toThrow(/Service not found/);

		const redis = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "redis",
			name: "cache",
		});
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				owner: { kind: "database", id: redis },
			}),
		).rejects.toThrow(/volume backups/);

		const foreign = await asUser(t, "eve").action(
			api.databases.destinations.create,
			{ organizationId: "org2", ...destinationArgs, secretAccessKey: "x" },
		);
		await expect(
			alice.mutation(api.databases.backups.create, {
				...base,
				destinationId: foreign,
			}),
		).rejects.toThrow(/Destination not found/);
		await expect(
			asUser(t, "eve").mutation(api.databases.backups.create, base),
		).rejects.toThrow(/Not a member/);
	});

	test("a manual run gives the agent a snapshot with retention and folder", async () => {
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		const backupId = await asUser(t, "alice").mutation(
			api.databases.backups.create,
			{ ...backupArgs(databaseId, destinationId), enabled: false },
		);
		const jobId = await asUser(t, "alice").mutation(
			api.databases.backups.runNow,
			{ backupId },
		);
		if (!jobId) throw new Error("no job");
		const agent = asAgent(t, await addAgent(t));
		await expect(
			agent.query(api.databases.agent.getBackupContext, {
				jobId,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		const claim = await agent.mutation(api.agent.claimNext, {});
		const lease = { jobId, leaseId: claim?.leaseId ?? "" };
		const appName = (await t.run((ctx) => ctx.db.get("databases", databaseId)))
			?.appName;
		const context = await agent.query(
			api.databases.agent.getBackupContext,
			lease,
		);
		expect(context).toMatchObject({
			databaseType: "postgres",
			database: "shop",
			keepLatestCount: 3,
			folder: `${appName}/daily/`,
			target: { kind: "swarm", appName },
			credentials: { databaseUser: "shop", password: "pgpass" },
			destination: { secretAccessKey: SECRET_KEY, bucket: "backups" },
		});
		await agent.mutation(api.databases.agent.reportBackup, {
			...lease,
			status: "success",
			file: `${appName}/daily/x.sql.gz`,
		});
		const runs = await asUser(t, "bob").query(api.databases.backups.runs, {
			backupId,
		});
		expect(runs[0]?.description).toBe(`${appName}/daily/x.sql.gz`);
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(
			scheduled.some(
				(fn) =>
					fn.name.includes("notifications") &&
					(fn.args[0] as { event: { type: string } }).event.type ===
						"databaseBackup",
			),
		).toBe(true);
	});

	test("restore validates the file and runs in the database's group", async () => {
		const t = setup();
		const { databaseId, destinationId, environmentId } = await seed(t);
		const alice = asUser(t, "alice");
		const args = {
			owner: { kind: "database" as const, id: databaseId },
			destinationId,
			backupFile: "postgres-old/daily/2026.sql.gz",
			databaseName: "shop",
			databaseType: "postgres" as const,
		};
		await expect(
			alice.mutation(api.databases.backups.restore, {
				...args,
				backupFile: "../etc/passwd.sql.gz",
			}),
		).rejects.toThrow(/Invalid backup file/);
		await expect(
			alice.mutation(api.databases.backups.restore, {
				...args,
				backupFile: "a/b.bson.gz",
			}),
		).rejects.toThrow(/Invalid backup file/);
		await expect(
			asUser(t, "eve").mutation(api.databases.backups.restore, args),
		).rejects.toThrow(/Not a member/);
		await grantMember(t, "org1", "bob", { services: [] });
		await expect(
			asUser(t, "bob").mutation(api.databases.backups.restore, args),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		// A scoped member restores only from their services' backup folders.
		const otherId = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "postgres",
			name: "Billing DB",
			databaseName: "billing",
			databaseUser: "billing",
			databasePassword: "pgpass",
		});
		const appNameOf = (id: Id<"databases">) =>
			t.run(async (ctx) => (await ctx.db.get("databases", id))?.appName);
		await expect(
			asUser(t, "bob").mutation(api.databases.backups.restore, {
				...args,
				backupFile: `${await appNameOf(otherId)}/daily/2026.sql.gz`,
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "bob").mutation(api.databases.backups.restore, args),
		).rejects.toThrow(/backup folder of a service you have access to/);
		await asUser(t, "bob").mutation(api.databases.backups.restore, {
			...args,
			backupFile: `${await appNameOf(databaseId)}/daily/2026.sql.gz`,
		});
		const jobId = await alice.mutation(api.databases.backups.restore, args);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			group: `postgres:${databaseId}`,
			spec: { kind: "databases.restore", backupFile: args.backupFile },
		});
	});
});

describe("volume backups", () => {
	test("owners resolve by kind; unknown applications are rejected", async () => {
		const t = setup();
		const { databaseId, destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const base = {
			name: "data",
			volumeName: "pg-data",
			prefix: "vol",
			turnOff: true,
			cronExpression: "0 1 * * *",
			enabled: false,
			destinationId,
		};
		await expect(
			alice.mutation(api.databases.volumeBackups.create, {
				...base,
				owner: { kind: "application", id: "nope" },
			}),
		).rejects.toThrow(/Service not found/);
		await expect(
			alice.mutation(api.databases.volumeBackups.create, {
				...base,
				owner: { kind: "database", id: databaseId },
				volumeName: "bad name",
			}),
		).rejects.toThrow(/Invalid volume name/);
		const volumeBackupId = await alice.mutation(
			api.databases.volumeBackups.create,
			{ ...base, owner: { kind: "database", id: databaseId } },
		);
		const jobId = await alice.mutation(api.databases.volumeBackups.runNow, {
			volumeBackupId,
		});
		if (!jobId) throw new Error("no job");
		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		const appName = (await t.run((ctx) => ctx.db.get("databases", databaseId)))
			?.appName;
		const context = await agent.query(
			api.databases.agent.getVolumeBackupContext,
			{ jobId, leaseId: claim?.leaseId ?? "" },
		);
		expect(context).toMatchObject({
			volumeName: "pg-data",
			turnOff: true,
			folder: `${appName}/vol/`,
			service: { kind: "swarm", serviceName: appName },
		});
		await expect(
			asUser(t, "eve").query(api.databases.volumeBackups.list, {
				owner: { kind: "database", id: databaseId },
			}),
		).rejects.toThrow(/Not a member/);
		expect(
			await asUser(t, "bob").query(api.databases.volumeBackups.list, {
				owner: { kind: "database", id: databaseId },
			}),
		).toHaveLength(1);
		const memberRunId = await asUser(t, "bob").mutation(
			api.databases.volumeBackups.runNow,
			{ volumeBackupId },
		);
		expect(memberRunId).not.toBeNull();
		await grantMember(t, "org1", "bob", { services: [] });
		await expect(
			asUser(t, "bob").query(api.databases.volumeBackups.list, {
				owner: { kind: "database", id: databaseId },
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "bob").mutation(api.databases.volumeBackups.runNow, {
				volumeBackupId,
			}),
		).rejects.toThrow(/access to this service/);
	});
});
