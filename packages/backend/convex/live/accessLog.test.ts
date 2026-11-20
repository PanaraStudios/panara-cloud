import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const cleanupJobs = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.query("jobs").collect()).filter(
			(job) => job.spec.kind === "live.accessLogCleanup",
		),
	);

describe("access log cleanup schedule", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("defaults to daily at midnight and only admins change it", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "mallory", "member");
		const alice = asUser(t, "alice");
		expect(
			await alice.query(api.live.accessLog.status, { organizationId: "org1" }),
		).toMatchObject({ enabled: false, cronExpression: "0 0 * * *" });
		await expect(
			asUser(t, "mallory").mutation(api.live.accessLog.setCleanupSchedule, {
				organizationId: "org1",
				cronExpression: "0 * * * *",
			}),
		).rejects.toThrow();
		await expect(
			alice.mutation(api.live.accessLog.setCleanupSchedule, {
				organizationId: "org1",
				cronExpression: "not a cron",
			}),
		).rejects.toThrow(/Invalid cron/);
		await alice.mutation(api.live.accessLog.setCleanupSchedule, {
			organizationId: "org1",
			cronExpression: "0 * * * *",
		});
		expect(
			await alice.query(api.live.accessLog.status, { organizationId: "org1" }),
		).toMatchObject({ enabled: false, cronExpression: "0 * * * *" });
	});

	test("queues a truncation when the host's cron comes due", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		await alice.mutation(api.live.accessLog.toggle, {
			organizationId: "org1",
			enable: true,
		});
		await alice.mutation(api.live.accessLog.setCleanupSchedule, {
			organizationId: "org1",
			cronExpression: "30 10 * * *",
		});
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(0);

		vi.setSystemTime(new Date("2026-11-18T10:31:00Z"));
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(1);

		vi.setSystemTime(new Date("2026-11-18T10:32:00Z"));
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(1);

		await alice.mutation(api.live.accessLog.toggle, {
			organizationId: "org1",
			enable: false,
		});
		vi.setSystemTime(new Date("2026-11-19T10:31:00Z"));
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(1);
	});
});
