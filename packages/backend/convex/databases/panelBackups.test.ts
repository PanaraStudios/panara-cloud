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

const at = (iso: string) => new Date(iso).getTime();
const SECRET_KEY = "panel-secret-key-123";

const destinationArgs = {
	name: "s3",
	accessKey: "panel-access",
	bucket: "panel",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: [],
};

// org1 holds the oldest membership, so it is the instance's root
// organization and its admins are instance administrators.
const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const destinationId = await asUser(t, "alice").action(
		api.databases.destinations.create,
		{ organizationId: "org1", ...destinationArgs, secretAccessKey: SECRET_KEY },
	);
	const foreignDestinationId = await asUser(t, "eve").action(
		api.databases.destinations.create,
		{ organizationId: "org2", ...destinationArgs, secretAccessKey: "other" },
	);
	return { destinationId, foreignDestinationId };
};

const backupArgs = (destinationId: Id<"destinations">) => ({
	destinationId,
	cronExpression: "0 3 * * *",
	timezone: "UTC",
	enabled: true,
	prefix: "/nightly/",
	keepLatestCount: 5,
});

describe("panel backups", () => {
	test("only instance administrators manage them, with root-org destinations", async () => {
		const t = setup();
		const { destinationId, foreignDestinationId } = await seed(t);
		await expect(
			asUser(t, "bob").mutation(
				api.databases.panelBackups.create,
				backupArgs(destinationId),
			),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "eve").mutation(
				api.databases.panelBackups.create,
				backupArgs(foreignDestinationId),
			),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "alice").mutation(
				api.databases.panelBackups.create,
				backupArgs(foreignDestinationId),
			),
		).rejects.toThrow(/Destination not found/);
		await expect(
			asUser(t, "alice").mutation(api.databases.panelBackups.create, {
				...backupArgs(destinationId),
				cronExpression: "nope",
			}),
		).rejects.toThrow(/Invalid cron/);
		await expect(
			asUser(t, "alice").mutation(api.databases.panelBackups.create, {
				...backupArgs(destinationId),
				prefix: "../escape",
			}),
		).rejects.toThrow(/Invalid prefix/);

		const panelBackupId = await asUser(t, "alice").mutation(
			api.databases.panelBackups.create,
			backupArgs(destinationId),
		);
		const listed = await asUser(t, "alice").query(
			api.databases.panelBackups.list,
			{},
		);
		expect(listed).toMatchObject([
			{
				_id: panelBackupId,
				folder: "panara-cloud-panel/nightly/",
				recentRuns: [],
			},
		]);
		expect(listed[0]).not.toHaveProperty("scheduledFunctionId");
		expect(JSON.stringify(listed)).not.toContain(SECRET_KEY);
		await expect(
			asUser(t, "bob").query(api.databases.panelBackups.list, {}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "eve").mutation(api.databases.panelBackups.runNow, {
				panelBackupId,
			}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "eve").mutation(api.databases.panelBackups.remove, {
				panelBackupId,
			}),
		).rejects.toThrow(/instance administrator/);
	});

	test("schedules runs, re-arms after reconcile and disarms when disabled", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T02:59:00Z"));
		const t = setup();
		const { destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const panelBackupId = await alice.mutation(
			api.databases.panelBackups.create,
			backupArgs(destinationId),
		);
		const row = await t.run((ctx) => ctx.db.get("panelBackups", panelBackupId));
		expect(row?.nextRunAt).toBe(at("2026-01-15T03:00:00Z"));

		vi.advanceTimersByTime(61_000);
		await t.finishInProgressScheduledFunctions();
		const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
		expect(jobs).toMatchObject([
			{
				organizationId: "org1",
				partition: "local",
				group: "panel-backup",
				spec: { kind: "databases.panelBackupRun", panelBackupId },
				idempotent: false,
			},
		]);
		const runs = await alice.query(api.databases.panelBackups.runs, {
			panelBackupId,
		});
		expect(runs).toMatchObject([
			{ jobId: jobs[0]?._id, description: "Scheduled backup" },
		]);

		await t.run(async (ctx) => {
			for (const fn of await ctx.db.system
				.query("_scheduled_functions")
				.collect()) {
				if (fn.state.kind === "pending") await ctx.scheduler.cancel(fn._id);
			}
		});
		expect(
			await t.mutation(
				internal.databases.panelBackups.reconcilePanelBackups,
				{},
			),
		).toEqual({ rescheduled: 1, isDone: true });
		expect(
			await t.mutation(
				internal.databases.panelBackups.reconcilePanelBackups,
				{},
			),
		).toEqual({ rescheduled: 0, isDone: true });

		const before = await t.run((ctx) =>
			ctx.db.get("panelBackups", panelBackupId),
		);
		await alice.mutation(api.databases.panelBackups.setEnabled, {
			panelBackupId,
			enabled: false,
		});
		await t.mutation(internal.databases.panelBackups.fire, {
			panelBackupId,
			generation: before?.generation ?? 0,
		});
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			1,
		);
		const after = await t.run((ctx) =>
			ctx.db.get("panelBackups", panelBackupId),
		);
		expect(after?.nextRunAt).toBeUndefined();
	});

	test("runNow and restore queue panel-host jobs; listFiles reads the backup folder", async () => {
		const t = setup();
		const { destinationId, foreignDestinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const panelBackupId = await alice.mutation(
			api.databases.panelBackups.create,
			{ ...backupArgs(destinationId), enabled: false },
		);
		const jobId = await alice.mutation(api.databases.panelBackups.runNow, {
			panelBackupId,
		});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId as Id<"jobs">));
		expect(job).toMatchObject({ partition: "local", group: "panel-backup" });
		const deployment = await t.run((ctx) =>
			ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId as Id<"jobs">))
				.unique(),
		);
		expect(deployment).toMatchObject({
			target: { kind: "panelBackup", id: panelBackupId },
			description: "Manual backup",
		});

		const { opId } = await alice.mutation(
			api.databases.panelBackups.listFiles,
			{
				panelBackupId,
			},
		);
		const op = await t.run((ctx) => ctx.db.get("databaseOps", opId));
		expect(op?.request).toEqual({
			kind: "listBackupFiles",
			destinationId,
			path: "panara-cloud-panel/nightly/",
			include: "panel-backup-*.tar.gz",
		});

		for (const backupFile of [
			"/abs.tar.gz",
			"a/../b.tar.gz",
			"panara-cloud-panel/x.zip",
		]) {
			await expect(
				alice.mutation(api.databases.panelBackups.restore, {
					destinationId,
					backupFile,
				}),
			).rejects.toThrow(/Invalid backup file/);
		}
		await expect(
			alice.mutation(api.databases.panelBackups.restore, {
				destinationId: foreignDestinationId,
				backupFile: "panara-cloud-panel/panel-backup-x.tar.gz",
			}),
		).rejects.toThrow(/Destination not found/);
		await expect(
			asUser(t, "bob").mutation(api.databases.panelBackups.restore, {
				destinationId,
				backupFile: "panara-cloud-panel/panel-backup-x.tar.gz",
			}),
		).rejects.toThrow(/instance administrator/);
		const restoreJobId = await alice.mutation(
			api.databases.panelBackups.restore,
			{ destinationId, backupFile: "panara-cloud-panel/panel-backup-x.tar.gz" },
		);
		const restoreJob = await t.run((ctx) => ctx.db.get("jobs", restoreJobId));
		expect(restoreJob).toMatchObject({
			partition: "local",
			group: "panel-backup",
			spec: {
				kind: "databases.panelRestore",
				destinationId,
				backupFile: "panara-cloud-panel/panel-backup-x.tar.gz",
			},
		});
	});

	test("the agent context needs the job's lease and reports notify instance-wide", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const panelBackupId = await alice.mutation(
			api.databases.panelBackups.create,
			{ ...backupArgs(destinationId), enabled: false },
		);
		const jobId = (await alice.mutation(api.databases.panelBackups.runNow, {
			panelBackupId,
		})) as Id<"jobs">;
		const agent = asAgent(t, await addAgent(t));
		await expect(
			agent.query(api.databases.agent.getPanelBackupContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			alice.query(api.databases.agent.getPanelBackupContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Agent authentication required/);

		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(jobId);
		const lease = { jobId, leaseId: claim?.leaseId ?? "" };
		const context = await agent.query(
			api.databases.agent.getPanelBackupContext,
			lease,
		);
		expect(context).toMatchObject({
			panelBackupId,
			folder: "panara-cloud-panel/nightly/",
			keepLatestCount: 5,
			destination: { bucket: "panel", secretAccessKey: SECRET_KEY },
		});
		await expect(
			agent.query(api.databases.agent.getPanelRestoreContext, lease),
		).rejects.toThrow(/Not a databases.panelRestore job/);

		await agent.mutation(api.databases.agent.reportPanelBackup, {
			...lease,
			status: "success",
			file: "panara-cloud-panel/nightly/panel-backup-1.tar.gz",
			backupSize: "1.00 MB",
		});
		const deployment = await t.run((ctx) =>
			ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique(),
		);
		expect(deployment?.description).toBe(
			"panara-cloud-panel/nightly/panel-backup-1.tar.gz",
		);
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(
			scheduled.find((fn) => fn.name.includes("notifications"))?.args[0],
		).toEqual({
			organizationId: null,
			event: { type: "panelBackup", status: "success", backupSize: "1.00 MB" },
		});
	});

	test("deleting the destination removes its panel backups", async () => {
		vi.useFakeTimers();
		const t = setup();
		const { destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		await alice.mutation(
			api.databases.panelBackups.create,
			backupArgs(destinationId),
		);
		await alice.mutation(api.databases.destinations.remove, { destinationId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await t.run((ctx) => ctx.db.query("panelBackups").collect()),
		).toHaveLength(0);
	});
});
