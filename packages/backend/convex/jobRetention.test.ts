import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	DEPLOYMENT_HISTORY_KEEP,
	HOUSEKEEPING_RETENTION_MS,
} from "./jobRetention";
import { LOCAL_PARTITION } from "./tables/core";
import { addMember, asUser, setup, type TestConvex } from "./test.setup";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 1);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
});

type Spec = Doc<"jobs">["spec"];

const INSPECT: Spec = { kind: "infra.inspect", what: "containers" };
const GROUP = "inspect:local:containers";

// A job created now that finished `ranMs` later, with `chunks` log chunks.
const addJob = async (
	t: TestConvex,
	options: {
		group?: string;
		spec?: Spec;
		status?: Doc<"jobs">["status"];
		chunks?: number;
		ranMs?: number;
	} = {},
) => {
	const status = options.status ?? "succeeded";
	const finished = !["queued", "running"].includes(status);
	return await t.run(async (ctx) => {
		const jobId = await ctx.db.insert("jobs", {
			organizationId: "org1",
			partition: LOCAL_PARTITION,
			group: options.group ?? GROUP,
			spec: options.spec ?? INSPECT,
			status,
			attempts: 1,
			maxAttempts: 1,
			idempotent: true,
			cancelRequested: false,
			startedAt: Date.now(),
			finishedAt: finished ? Date.now() + (options.ranMs ?? 1000) : undefined,
		});
		for (let seq = 0; seq < (options.chunks ?? 1); seq++) {
			await ctx.db.insert("jobLogChunks", {
				jobId,
				seq,
				text: `line ${seq}\n`,
			});
		}
		return jobId;
	});
};

const addDeployment = (
	t: TestConvex,
	jobId: Id<"jobs">,
	target = { kind: "server", id: "local" },
) =>
	t.run((ctx) =>
		ctx.db.insert("deployments", {
			organizationId: "org1",
			jobId,
			target,
			title: "Deploy",
		}),
	);

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

const prune = async (t: TestConvex) => {
	await t.mutation(internal.jobRetention.prune, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
};

const exists = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run(async (ctx) => (await ctx.db.get("jobs", jobId)) !== null);

const logCount = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("jobLogChunks")
					.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
					.take(1000)
			).length,
	);

const remaining = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.query("jobs").take(1000)).map((j) => j._id),
	);

describe("housekeeping jobs", () => {
	test("go with their log once 7 days old, looked at a day later", async () => {
		const t = setup();
		const old = await addJob(t, { chunks: 3 });
		later(1000);
		const newest = await addJob(t);
		// The sweep reaches a job 8 days after it was created.
		later(HOUSEKEEPING_RETENTION_MS + DAY - 1001);
		await prune(t);
		expect(await exists(t, old)).toBe(true);
		later(2);
		await prune(t);
		expect(await exists(t, old)).toBe(false);
		expect(await logCount(t, old)).toBe(0);
		// The newest of its group and kind stays whatever its age.
		later(HOUSEKEEPING_RETENTION_MS * 10);
		await prune(t);
		expect(await exists(t, newest)).toBe(true);
	});

	test("unfinished jobs and jobs that finished recently stay", async () => {
		const t = setup();
		const queued = await addJob(t, { status: "queued" });
		const running = await addJob(t, { status: "running" });
		// Ran for three days: finished less than 7 days before the sweep.
		const slow = await addJob(t, { status: "failed", ranMs: 3 * DAY });
		await addJob(t, { status: "failed" });
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await addJob(t);
		await prune(t);
		expect(await exists(t, queued)).toBe(true);
		expect(await exists(t, running)).toBe(true);
		expect(await exists(t, slow)).toBe(true);
	});

	test("keep the newest of each kind and the newest success", async () => {
		const t = setup();
		const olderSuccess = await addJob(t);
		later(1000);
		const lastSuccess = await addJob(t);
		later(1000);
		const failed = await addJob(t, { status: "failed" });
		later(1000);
		const lastFailure = await addJob(t, { status: "failed" });
		const otherKind = await addJob(t, {
			group: "traefik:local",
			spec: { kind: "live.accessLogToggle", enable: true },
		});
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await prune(t);
		expect(await exists(t, olderSuccess)).toBe(false);
		expect(await exists(t, failed)).toBe(false);
		// What pending changes, "last job" links and lists still read.
		expect(await exists(t, lastSuccess)).toBe(true);
		expect(await exists(t, lastFailure)).toBe(true);
		expect(await exists(t, otherKind)).toBe(true);
	});

	test("a job kept as the newest goes once a newer one is old too", async () => {
		const t = setup();
		const first = await addJob(t);
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await prune(t);
		expect(await exists(t, first)).toBe(true);
		const second = await addJob(t);
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await prune(t);
		expect(await exists(t, first)).toBe(false);
		expect(await exists(t, second)).toBe(true);
	});

	test("one-off operations keep nothing; the last panel update stays", async () => {
		const t = setup();
		const op = await addJob(t, {
			group: "databaseOp:op1",
			spec: { kind: "infra.publicIp" },
			status: "failed",
		});
		const update = await addJob(t, {
			group: "panel",
			spec: { kind: "infra.panelAction", action: { type: "update" } },
			status: "failed",
		});
		later(1000);
		await addJob(t, {
			group: "panel",
			spec: { kind: "infra.panelAction", action: { type: "checkUpdate" } },
		});
		later(1000);
		const check = await addJob(t, {
			group: "panel",
			spec: { kind: "infra.panelAction", action: { type: "checkUpdate" } },
		});
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await prune(t);
		expect(await exists(t, op)).toBe(false);
		expect(await exists(t, update)).toBe(true);
		expect(await exists(t, check)).toBe(true);
		expect((await remaining(t)).length).toBe(2);
	});

	test("deployment history is not pruned by age", async () => {
		const t = setup();
		const deploy = await addJob(t, {
			group: "server:s1",
			spec: { kind: "infra.publicIp" },
		});
		await addDeployment(t, deploy);
		later(1000);
		await addJob(t, { group: "server:s1", spec: { kind: "infra.publicIp" } });
		later(HOUSEKEEPING_RETENTION_MS * 4);
		await prune(t);
		expect(await exists(t, deploy)).toBe(true);
	});

	test("are worked off in small batches with a chain per run", async () => {
		const t = setup();
		for (let i = 0; i < 120; i++) {
			await addJob(t, { chunks: 2 });
			later(10);
		}
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		const first = await t.mutation(internal.jobRetention.prune, {});
		// One batch per mutation, so no run reads much.
		expect(first.phase).toBe("jobs");
		expect(first.done).toBe(false);
		expect(first.deleted).toBeLessThanOrEqual(40);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		expect(await remaining(t)).toHaveLength(1);
		const chunks = await t.run(
			async (ctx) => (await ctx.db.query("jobLogChunks").take(1000)).length,
		);
		expect(chunks).toBe(2);
	});

	test("a long log goes a few chunks per mutation", async () => {
		const t = setup();
		const noisy = await addJob(t, { chunks: 120 });
		later(1000);
		await addJob(t);
		later(HOUSEKEEPING_RETENTION_MS + 2 * DAY);
		await t.mutation(internal.jobRetention.prune, {});
		expect(await exists(t, noisy)).toBe(false);
		await t.mutation(internal.jobRetention.purgeLogs, { jobIds: [noisy] });
		expect(await logCount(t, noisy)).toBe(70);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		expect(await logCount(t, noisy)).toBe(0);
	});
});

describe("deployment history", () => {
	const seedApp = async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const { environmentId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Web" },
		);
		const applicationId = await asUser(t, "alice").mutation(
			api.applications.applications.create,
			{ environmentId, name: "Web" },
		);
		return { t, applicationId };
	};

	test("keeps the newest 100 deployments of a service with their logs", async () => {
		const { t, applicationId } = await seedApp();
		const target = { kind: "application", id: applicationId as string };
		const group = `application:${applicationId}`;
		const jobs: Id<"jobs">[] = [];
		for (let i = 0; i < DEPLOYMENT_HISTORY_KEEP + 5; i++) {
			const jobId = await addJob(t, {
				group,
				spec: { kind: "application.deploy", applicationId },
				status: i === 1 ? "running" : "failed",
				chunks: 2,
			});
			await addDeployment(t, jobId, target);
			jobs.push(jobId);
			later(10);
		}
		const rollback = await t.run(async (ctx) => {
			const row = await ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobs[0] as Id<"jobs">))
				.unique();
			return await ctx.db.insert("applicationRollbacks", {
				organizationId: "org1",
				applicationId,
				version: 1,
				image: "web:1",
				localTag: "web:v1",
				deploymentId: row?._id,
			});
		});
		await prune(t);
		const rows = await asUser(t, "alice").query(api.jobs.deployments, {
			organizationId: "org1",
			target,
		});
		expect(rows).toHaveLength(50);
		// The 5 oldest go, except the one still running.
		for (const [index, jobId] of jobs.entries()) {
			const gone = index < 5 && index !== 1;
			expect(await exists(t, jobId)).toBe(!gone);
			expect(await logCount(t, jobId)).toBe(gone ? 0 : 2);
		}
		const count = await t.run(
			async (ctx) => (await ctx.db.query("deployments").take(1000)).length,
		);
		expect(count).toBe(DEPLOYMENT_HISTORY_KEEP + 1);
		const unlinked = await t.run((ctx) =>
			ctx.db.get("applicationRollbacks", rollback),
		);
		expect(unlinked?.deploymentId).toBeUndefined();
	});

	test("never drops the last successful deploy a service's state depends on", async () => {
		const { t, applicationId } = await seedApp();
		const target = { kind: "application", id: applicationId as string };
		const group = `application:${applicationId}`;
		const success = await addJob(t, {
			group,
			spec: { kind: "application.deploy", applicationId },
		});
		await addDeployment(t, success, target);
		for (let i = 0; i < DEPLOYMENT_HISTORY_KEEP + 3; i++) {
			later(10);
			const jobId = await addJob(t, {
				group,
				spec: { kind: "application.deploy", applicationId },
				status: "failed",
			});
			await addDeployment(t, jobId, target);
		}
		await prune(t);
		expect(await exists(t, success)).toBe(true);
		const pending = await asUser(t, "alice").query(
			api.serviceEvents.pendingChanges,
			{ target: { kind: "application", id: applicationId } },
		);
		expect(pending.deployState).toBe("deployed");
	});
});
