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
import { nextRunAfter } from "./lib/cron";

afterEach(() => {
	vi.useRealTimers();
});

const at = (iso: string) => new Date(iso).getTime();

const createServer = async (t: TestConvex, organizationId = "org1") =>
	await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId,
			name: "web-1",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		}),
	);

const baseFields = {
	name: "nightly",
	cronExpression: "0 9 * * *",
	shellType: "bash" as const,
	command: "",
	script: "echo hello",
	enabled: true,
};

describe("next run computation", () => {
	test("honours the timezone", () => {
		const after = at("2026-01-15T12:00:00Z");
		expect(nextRunAfter("0 9 * * *", "America/New_York", after)).toBe(
			at("2026-01-15T14:00:00Z"),
		);
		expect(nextRunAfter("0 9 * * *", "Asia/Kolkata", after)).toBe(
			at("2026-01-16T03:30:00Z"),
		);
		expect(nextRunAfter("0 9 * * *", undefined, after)).toBe(
			at("2026-01-16T09:00:00Z"),
		);
	});

	test("crosses a DST change at local wall-clock time", () => {
		// US DST starts 2026-03-08: 9am is 14:00Z before and 13:00Z after.
		expect(
			nextRunAfter("0 9 * * *", "America/New_York", at("2026-03-07T15:00:00Z")),
		).toBe(at("2026-03-08T13:00:00Z"));
	});

	test("supports seconds and weekday fields", () => {
		expect(
			nextRunAfter("30 0 12 * * MON", "UTC", at("2026-01-15T12:00:00Z")),
		).toBe(at("2026-01-19T12:00:30Z"));
	});
});

describe("schedules", () => {
	test("creating computes the next run in the schedule's timezone", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T12:00:00Z"));
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const serverId = await createServer(t);
		const scheduleId = await asUser(t, "alice").mutation(
			api.platform.schedules.create,
			{
				organizationId: "org1",
				target: { kind: "server", serverId },
				...baseFields,
				timezone: "America/New_York",
			},
		);
		const schedule = await asUser(t, "alice").query(
			api.platform.schedules.get,
			{
				scheduleId,
			},
		);
		expect(schedule).toMatchObject({
			nextRunAt: at("2026-01-15T14:00:00Z"),
			script: "echo hello",
			targetId: serverId,
		});
		expect(schedule).not.toHaveProperty("scheduledFunctionId");
		const pending = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			scheduledTime: at("2026-01-15T14:00:00Z"),
			state: { kind: "pending" },
		});
	});

	test("rejects invalid cron expressions, timezones and missing scripts", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const target = { kind: "panel" as const };
		await expect(
			alice.mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target,
				...baseFields,
				cronExpression: "every day",
			}),
		).rejects.toThrow(/Invalid cron expression/);
		await expect(
			alice.mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target,
				...baseFields,
				timezone: "Mars/Olympus",
			}),
		).rejects.toThrow(/Unknown timezone/);
		await expect(
			alice.mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target,
				...baseFields,
				script: "  ",
			}),
		).rejects.toThrow(/Script is required/);
	});

	test("host schedules are admin-only and targets must belong to the org", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const serverId = await createServer(t);
		const args = {
			organizationId: "org1",
			target: { kind: "server" as const, serverId },
			...baseFields,
		};
		await expect(
			asUser(t, "bob").mutation(api.platform.schedules.create, args),
		).rejects.toThrow(/owners and admins/);
		await expect(
			asUser(t, "mallory").mutation(api.platform.schedules.create, {
				...args,
				organizationId: "org2",
			}),
		).rejects.toThrow(/Server not found/);
		const scheduleId = await asUser(t, "alice").mutation(
			api.platform.schedules.create,
			args,
		);
		await expect(
			asUser(t, "bob").query(api.platform.schedules.list, {
				organizationId: "org1",
				kind: "server",
				targetId: serverId,
			}),
		).rejects.toThrow(/owners and admins/);
		await expect(
			asUser(t, "mallory").query(api.platform.schedules.get, { scheduleId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "mallory").mutation(api.platform.schedules.runNow, {
				scheduleId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "alice").mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target: { kind: "application", applicationId: "nope" },
				...baseFields,
				command: "ls",
			}),
		).rejects.toThrow(/Application not found/);
		const listed = await asUser(t, "alice").query(api.platform.schedules.list, {
			organizationId: "org1",
			kind: "server",
			targetId: serverId,
		});
		expect(listed.map((s) => s._id)).toEqual([scheduleId]);
	});

	test("a due schedule enqueues a run linked to a deployment and reschedules itself", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T08:59:00Z"));
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const scheduleId = await asUser(t, "alice").mutation(
			api.platform.schedules.create,
			{ organizationId: "org1", target: { kind: "panel" }, ...baseFields },
		);
		vi.advanceTimersByTime(61_000);
		await t.finishInProgressScheduledFunctions();

		const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			organizationId: "org1",
			partition: "local",
			group: `schedule:${scheduleId}`,
			spec: { kind: "platform.scheduleRun", scheduleId },
			status: "queued",
		});
		const runs = await asUser(t, "alice").query(api.platform.schedules.runs, {
			scheduleId,
		});
		expect(runs).toMatchObject([
			{ jobId: jobs[0]._id, status: "queued", description: "Scheduled run" },
		]);
		const schedule = await t.run((ctx) => ctx.db.get("schedules", scheduleId));
		expect(schedule?.nextRunAt).toBe(at("2026-01-16T09:00:00Z"));

		// While that run is still queued, the next tick doesn't pile up another.
		vi.setSystemTime(at("2026-01-16T09:00:01Z"));
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			1,
		);
	});

	test("disabling cancels the pending run and a stale run is a no-op", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T08:00:00Z"));
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const scheduleId = await alice.mutation(api.platform.schedules.create, {
			organizationId: "org1",
			target: { kind: "panel" },
			...baseFields,
		});
		const before = await t.run((ctx) => ctx.db.get("schedules", scheduleId));
		await alice.mutation(api.platform.schedules.setEnabled, {
			scheduleId,
			enabled: false,
		});
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled.map((s) => s.state.kind)).toEqual(["canceled"]);
		await t.mutation(internal.platform.schedules.fire, {
			scheduleId,
			generation: before?.generation ?? 0,
		});
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			0,
		);
		const after = await t.run((ctx) => ctx.db.get("schedules", scheduleId));
		expect(after?.enabled).toBe(false);
		expect(after?.nextRunAt).toBeUndefined();
	});

	test("reconcile restores lost runs and is idempotent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(at("2026-01-15T08:00:00Z"));
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const ids: Id<"schedules">[] = [];
		for (const name of ["a", "b"]) {
			ids.push(
				await alice.mutation(api.platform.schedules.create, {
					organizationId: "org1",
					target: { kind: "panel" },
					...baseFields,
					name,
				}),
			);
		}
		// Simulate a snapshot import: the documents survive, scheduler state doesn't.
		await t.run(async (ctx) => {
			for (const fn of await ctx.db.system
				.query("_scheduled_functions")
				.collect()) {
				await ctx.scheduler.cancel(fn._id);
			}
			await ctx.db.patch("schedules", ids[0], {
				scheduledFunctionId: undefined,
			});
		});

		expect(
			await t.mutation(internal.platform.schedules.reconcileSchedules, {}),
		).toEqual({ rescheduled: 2, isDone: true });
		expect(
			await t.mutation(internal.platform.schedules.reconcileSchedules, {}),
		).toEqual({ rescheduled: 0, isDone: true });
		const pending = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(fn) => fn.state.kind === "pending",
			),
		);
		expect(pending).toHaveLength(2);
		expect(
			pending.every((fn) => fn.scheduledTime === at("2026-01-15T09:00:00Z")),
		).toBe(true);
	});

	test("the agent gets the run context only while holding the lease", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const agent = asAgent(t, await addAgent(t));
		const scheduleId = await asUser(t, "alice").mutation(
			api.platform.schedules.create,
			{
				organizationId: "org1",
				target: { kind: "panel" },
				...baseFields,
				enabled: false,
			},
		);
		const jobId = await asUser(t, "alice").mutation(
			api.platform.schedules.runNow,
			{ scheduleId },
		);
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(jobId);
		if (!claim || !jobId) throw new Error("expected a claim");

		await expect(
			asUser(t, "alice").query(api.platform.agent.getScheduleRunContext, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).rejects.toThrow(/Agent authentication required/);
		await expect(
			agent.query(api.platform.agent.getScheduleRunContext, {
				jobId,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		expect(
			await agent.query(api.platform.agent.getScheduleRunContext, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).toMatchObject({
			kind: "host",
			script: "echo hello",
			shellType: "bash",
			scheduleId,
		});
	});

	test("removing a target's schedules cleans up scripts and pending runs", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const serverId = await createServer(t);
		await asUser(t, "alice").mutation(api.platform.schedules.create, {
			organizationId: "org1",
			target: { kind: "server", serverId },
			...baseFields,
		});
		await t.mutation(internal.platform.schedules.removeForTarget, {
			targetId: serverId,
		});
		const remaining = await t.run(async (ctx) => ({
			schedules: await ctx.db.query("schedules").collect(),
			scripts: await ctx.db.query("scheduleScripts").collect(),
			pending: (
				await ctx.db.system.query("_scheduled_functions").collect()
			).filter((fn) => fn.state.kind === "pending").length,
		}));
		expect(remaining).toEqual({ schedules: [], scripts: [], pending: 0 });
	});
});

describe("panel host schedules", () => {
	test("only the root organization's instance administrator manages them", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "eve", "owner");
		const eve = asUser(t, "eve");
		await expect(
			eve.mutation(api.platform.schedules.create, {
				organizationId: "org2",
				target: { kind: "panel" },
				...baseFields,
			}),
		).rejects.toThrow(/Only the instance administrator/);
		await expect(
			eve.query(api.platform.schedules.list, {
				organizationId: "org2",
				kind: "panel",
			}),
		).rejects.toThrow(/Only the instance administrator/);
		await expect(
			asUser(t, "bob").mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target: { kind: "panel" },
				...baseFields,
			}),
		).rejects.toThrow(/Only the instance administrator/);

		const serverId = await createServer(t, "org2");
		expect(
			await eve.mutation(api.platform.schedules.create, {
				organizationId: "org2",
				target: { kind: "server", serverId },
				...baseFields,
			}),
		).toBeTruthy();
		const alice = asUser(t, "alice");
		const scheduleId = await alice.mutation(api.platform.schedules.create, {
			organizationId: "org1",
			target: { kind: "panel" },
			...baseFields,
		});
		expect(
			await alice.query(api.platform.schedules.list, {
				organizationId: "org1",
				kind: "panel",
			}),
		).toMatchObject([{ _id: scheduleId }]);
	});

	test("a panel schedule left in another organization never runs and stays hidden", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org2", "eve", "owner");
		const scheduleId = await t.run(async (ctx) =>
			ctx.db.insert("schedules", {
				organizationId: "org2",
				target: { kind: "panel" },
				targetId: "org2",
				appName: "schedule-x",
				name: "x",
				cronExpression: "0 9 * * *",
				shellType: "bash",
				command: "",
				enabled: true,
				generation: 0,
			}),
		);
		await t.mutation(internal.platform.schedules.fire, {
			scheduleId,
			generation: 0,
		});
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(
			0,
		);
		const eve = asUser(t, "eve");
		await expect(
			eve.mutation(api.platform.schedules.runNow, { scheduleId }),
		).rejects.toThrow(/Only the instance administrator/);
		await expect(
			eve.query(api.platform.schedules.get, { scheduleId }),
		).rejects.toThrow(/Only the instance administrator/);
		const listed = await eve.query(api.platform.schedules.listForOrganization, {
			organizationId: "org2",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(listed.page).toEqual([]);
		await eve.mutation(api.platform.schedules.remove, { scheduleId });
	});
});

describe("compose schedules", () => {
	test("the service name is a plain compose service name", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "stack",
			serverId: await createServer(t),
			composeFile: "services:\n  web:\n    image: nginx\n",
		});
		const create = (serviceName: string) =>
			alice.mutation(api.platform.schedules.create, {
				organizationId: "org1",
				target: { kind: "compose", composeId, serviceName },
				...baseFields,
				command: "echo hi",
			});
		await expect(create("web; id")).rejects.toThrow(/service name may only/);
		expect(await create("web")).toBeTruthy();
	});
});
