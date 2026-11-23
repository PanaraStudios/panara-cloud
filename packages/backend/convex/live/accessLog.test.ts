import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import { accessLogState } from "./accessLog";

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
		const agent = asAgent(t, await addAgent(t));
		// Every queued job succeeds: the switch moves when its job does.
		const settle = async () => {
			for (;;) {
				const claimed = await agent.mutation(api.agent.claimNext, {});
				if (!claimed) return;
				await agent.mutation(api.agent.complete, {
					jobId: claimed.jobId,
					leaseId: claimed.leaseId,
					result: { kind: "none" },
				});
			}
		};
		await alice.mutation(api.live.accessLog.toggle, {
			organizationId: "org1",
			enable: true,
		});
		await settle();
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
		await settle();
		vi.setSystemTime(new Date("2026-11-19T10:31:00Z"));
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(1);
	});
});

describe("scheduled truncations", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const pendingRuns = (t: TestConvex) =>
		t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(run) =>
					run.name.includes("runCleanup") && run.state.kind === "pending",
			),
		);

	test("run at the host's cron time, not at the next hourly check", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const agent = asAgent(t, await addAgent(t));
		const settle = async () => {
			for (;;) {
				const claimed = await agent.mutation(api.agent.claimNext, {});
				if (!claimed) return;
				await agent.mutation(api.agent.complete, {
					jobId: claimed.jobId,
					leaseId: claimed.leaseId,
					result: { kind: "none" },
				});
			}
		};
		await alice.mutation(api.live.accessLog.setCleanupSchedule, {
			organizationId: "org1",
			cronExpression: "30 10 * * *",
		});
		// Off: nothing is scheduled.
		expect(await pendingRuns(t)).toHaveLength(0);
		await alice.mutation(api.live.accessLog.toggle, {
			organizationId: "org1",
			enable: true,
		});
		await settle();
		const [first] = await pendingRuns(t);
		expect(first?.scheduledTime).toBe(Date.parse("2026-11-18T10:30:00Z"));

		vi.advanceTimersByTime(31 * 60 * 1000);
		await t.finishInProgressScheduledFunctions();
		expect(await cleanupJobs(t)).toHaveLength(1);
		const [next] = await pendingRuns(t);
		expect(next?.scheduledTime).toBe(Date.parse("2026-11-19T10:30:00Z"));

		// A new schedule replaces the pending run.
		await alice.mutation(api.live.accessLog.setCleanupSchedule, {
			organizationId: "org1",
			cronExpression: "0 12 * * *",
		});
		const runs = await pendingRuns(t);
		expect(runs.map((run) => run.scheduledTime)).toEqual([
			Date.parse("2026-11-18T12:00:00Z"),
		]);

		await alice.mutation(api.live.accessLog.toggle, {
			organizationId: "org1",
			enable: false,
		});
		await settle();
		expect(await pendingRuns(t)).toHaveLength(0);
	});

	test("the hourly check schedules hosts that have no run", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		// Turned on before truncations were scheduled.
		await t.run((ctx) =>
			ctx.db.insert("accessLogSettings", {
				organizationId: "org1",
				enabled: true,
				cleanupCron: "0 * * * *",
				lastCleanupAt: Date.parse("2026-11-18T09:30:00Z"),
			}),
		);
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		// 10:00 came due since 09:30: queued now, next at 11:00.
		expect(await cleanupJobs(t)).toHaveLength(1);
		expect((await pendingRuns(t)).map((run) => run.scheduledTime)).toEqual([
			Date.parse("2026-11-18T11:00:00Z"),
		]);
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await pendingRuns(t)).toHaveLength(1);
	});
});

describe("the request logging switch follows its job", () => {
	const seed = async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const alice = asUser(t, "alice");
		const status = () =>
			alice.query(api.live.accessLog.status, { organizationId: "org1" });
		const stored = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query("accessLogSettings").first())?.enabled,
			);
		const press = (enable: boolean) =>
			alice.mutation(api.live.accessLog.toggle, {
				organizationId: "org1",
				enable,
			});
		const claim = async () => {
			const claimed = await agent.mutation(api.agent.claimNext, {});
			if (!claimed) throw new Error("expected a job to claim");
			return claimed;
		};
		const succeed = async () => {
			const claimed = await claim();
			await agent.mutation(api.agent.complete, {
				jobId: claimed.jobId,
				leaseId: claimed.leaseId,
				result: { kind: "none" },
			});
		};
		const fail = async (error: string) => {
			const claimed = await claim();
			await agent.mutation(api.agent.fail, {
				jobId: claimed.jobId,
				leaseId: claimed.leaseId,
				error,
			});
		};
		return { t, agent, status, stored, press, claim, succeed, fail };
	};

	test("it is not on until the job succeeded", async () => {
		const { status, stored, press, claim, agent } = await seed();
		const jobId = await press(true);
		expect(await status()).toMatchObject({
			enabled: false,
			changing: true,
			failure: null,
			lastJobId: jobId,
		});
		expect(await stored()).toBe(false);
		const claimed = await claim();
		expect(await status()).toMatchObject({ enabled: false, changing: true });
		await agent.mutation(api.agent.complete, {
			jobId: claimed.jobId,
			leaseId: claimed.leaseId,
			result: { kind: "none" },
		});
		expect(await status()).toMatchObject({
			enabled: true,
			changing: false,
			failure: null,
		});
		expect(await stored()).toBe(true);
	});

	test("a failed job leaves it off and says why", async () => {
		const { t, status, stored, press, fail } = await seed();
		await press(true);
		await fail(
			"Traefik config not found at /etc/panara-cloud/traefik/traefik.yml",
		);
		expect(await status()).toMatchObject({
			enabled: false,
			changing: false,
			failure:
				"Traefik config not found at /etc/panara-cloud/traefik/traefik.yml",
		});
		expect(await stored()).toBe(false);
		// Nothing takes the log for written: no truncation is ever queued.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.live.accessLog.enqueueCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(0);
		vi.useRealTimers();
	});

	test("turning it off that fails leaves it on", async () => {
		const { status, stored, press, succeed, fail } = await seed();
		await press(true);
		await succeed();
		await press(false);
		expect(await status()).toMatchObject({ enabled: true, changing: true });
		await fail("docker: not found");
		expect(await status()).toMatchObject({
			enabled: true,
			changing: false,
			failure: "docker: not found",
		});
		expect(await stored()).toBe(true);
	});

	test("two failed presses in a row do not turn it on", async () => {
		const { status, press, fail } = await seed();
		await press(true);
		await fail("x");
		await press(false);
		await fail("y");
		expect(await status()).toMatchObject({ enabled: false, failure: "y" });
	});

	test("an older job that succeeds late does not undo a later press", async () => {
		const { agent, status, stored, press, claim } = await seed();
		await press(true);
		const first = await claim();
		await press(false);
		await agent.mutation(api.agent.complete, {
			jobId: first.jobId,
			leaseId: first.leaseId,
			result: { kind: "none" },
		});
		// The switch points at the second job: the first one's end changes nothing.
		expect(await stored()).toBe(false);
		expect(await status()).toMatchObject({ enabled: false, changing: true });
	});

	test("a cancelled job changes nothing", async () => {
		const { status, stored, press, claim, agent, t } = await seed();
		const jobId = await press(true);
		const claimed = await claim();
		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId });
		// The agent stopped the work: it reports the job as not done.
		await agent.mutation(api.agent.fail, {
			jobId: claimed.jobId,
			leaseId: claimed.leaseId,
			error: "Cancelled",
		});
		expect(await stored()).toBe(false);
		expect(await status()).toMatchObject({
			enabled: false,
			failure: "The job was cancelled before it finished.",
		});
	});

	test("a cancel that came after Traefik was restarted: the switch says what the host does", async () => {
		const { status, stored, press, claim, agent, t } = await seed();
		const jobId = await press(true);
		const claimed = await claim();
		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId });
		await agent.mutation(api.agent.complete, {
			jobId: claimed.jobId,
			leaseId: claimed.leaseId,
			result: { kind: "none" },
		});
		expect(await stored()).toBe(true);
		expect(await status()).toMatchObject({
			enabled: true,
			changing: false,
			failure: null,
		});
	});

	test("the state by itself", () => {
		const job = (status: string, enable: boolean, error?: string) =>
			({
				status,
				error,
				spec: { kind: "live.accessLogToggle", enable },
			}) as never;
		expect(accessLogState(null, null)).toEqual({
			enabled: false,
			changing: false,
			failure: null,
		});
		// A job that is long gone: the stored value stands.
		expect(accessLogState({ enabled: true }, null).enabled).toBe(true);
		expect(
			accessLogState({ enabled: false }, job("queued", true)),
		).toMatchObject({ enabled: false, changing: true });
		expect(
			accessLogState({ enabled: true }, job("failed", false, "no")),
		).toMatchObject({ enabled: true, failure: "no" });
	});
});
