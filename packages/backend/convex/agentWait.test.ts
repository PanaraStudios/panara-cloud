import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { LEASE_MS } from "./lib/jobs";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "./test.setup";

type Fields = {
	organizationId?: string;
	partition?: string;
	group?: string;
	quick?: boolean;
	usesBuildSlot?: boolean;
	idempotent?: boolean;
};

const insertJob = (t: TestConvex, fields: Fields = {}) =>
	t.run((ctx) =>
		ctx.db.insert("jobs", {
			organizationId: fields.organizationId ?? "org1",
			partition: fields.partition ?? "local",
			group: fields.group ?? `g:${Math.random()}`,
			spec: fields.quick
				? { kind: "infra.inspect", what: "containers" }
				: { kind: "noop", message: "x" },
			status: "queued",
			attempts: 0,
			maxAttempts: 2,
			idempotent: fields.idempotent ?? false,
			usesBuildSlot: fields.usesBuildSlot ?? false,
			cancelRequested: false,
		} as never),
	);

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org2", "mallory", "owner");
	return t;
};

// A small deterministic generator, so a failing case can be replayed.
const random = (seed: number) => {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
};

describe("the claimable query the agent waits on", () => {
	test("is empty with no queue and names the job claimNext takes", async () => {
		const t = await seed();
		const agent = asAgent(t, await addAgent(t));
		expect(await agent.query(api.agent.claimable, {})).toEqual({
			next: null,
			nextQuick: null,
		});

		const deploy = await insertJob(t, { group: "application:a" });
		const inspect = await insertJob(t, { quick: true });
		expect(await agent.query(api.agent.claimable, {})).toEqual({
			next: deploy,
			nextQuick: inspect,
		});
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(deploy);
		expect(await agent.query(api.agent.claimable, {})).toEqual({
			next: inspect,
			nextQuick: inspect,
		});
	});

	test("skips a job that has to wait, so a later job wakes the agent", async () => {
		const t = await seed();
		const agent = asAgent(t, await addAgent(t));
		const first = await insertJob(t, { group: "application:a" });
		await insertJob(t, { group: "application:a" });
		await agent.mutation(api.agent.claimNext, {});
		// The second job of the same service waits: nothing to claim.
		expect(await agent.query(api.agent.claimable, {})).toEqual({
			next: null,
			nextQuick: null,
		});
		// hasQueuedJobs, which agents before 0.1.6 wait on, stays true and so
		// never told them about this one.
		expect(await agent.query(api.agent.hasQueuedJobs, {})).toBe(true);
		const other = await insertJob(t, { group: "application:b" });
		expect((await agent.query(api.agent.claimable, {})).next).toBe(other);
		expect(first).not.toBe(other);
	});

	test("agrees with claimNext through random queues, limits and finishes", async () => {
		let claimed = 0;
		let blocked = 0;
		for (const seedValue of [1, 7, 42, 2024]) {
			const next = random(seedValue);
			const pick = <T>(values: T[]) =>
				values[Math.floor(next() * values.length)] as T;
			const t = await seed();
			const agent = asAgent(t, await addAgent(t));
			const serverId = await t.run((ctx) =>
				ctx.db.insert("servers", {
					organizationId: "org1",
					name: "web-1",
					ipAddress: "10.0.0.5",
					port: 22,
					username: "root",
					serverType: "deploy",
					enableDockerCleanup: false,
					buildsConcurrency: 2,
				} as never),
			);
			for (let i = 0; i < 40; i++) {
				await insertJob(t, {
					organizationId: pick(["org1", "org2", "org3"]),
					partition: pick(["local", serverId]),
					group: pick(["application:a", "application:b", "compose:c", "x"]),
					quick: next() < 0.3,
					usesBuildSlot: next() < 0.6,
				});
			}
			const leases: { jobId: Id<"jobs">; leaseId: string }[] = [];
			for (let step = 0; step < 80; step++) {
				const expected = await agent.query(api.agent.claimable, {});
				if (next() < 0.35 && leases.length > 0) {
					const done = leases.splice(Math.floor(next() * leases.length), 1)[0];
					if (!done) throw new Error("expected a lease");
					await agent.mutation(api.agent.complete, {
						...done,
						result: { kind: "none" },
					});
					continue;
				}
				const quickOnly = next() < 0.4;
				const claim = await agent.mutation(api.agent.claimNext, { quickOnly });
				expect(claim?.jobId ?? null).toBe(
					quickOnly ? expected.nextQuick : expected.next,
				);
				if (claim) leases.push({ jobId: claim.jobId, leaseId: claim.leaseId });
				if (claim) claimed++;
				else blocked++;
			}
		}
		expect(claimed).toBeGreaterThan(40);
		expect(blocked).toBeGreaterThan(40);
	});

	test("two agents never claim the same job", async () => {
		const t = await seed();
		const a = asAgent(t, await addAgent(t));
		const b = asAgent(t, await addAgent(t));
		const jobs = [
			await insertJob(t, { group: "application:a" }),
			await insertJob(t, { group: "application:b" }),
			await insertJob(t, { group: "application:c" }),
		];
		// Both see the same work and both claim at once, as two agents woken by
		// the same update do.
		expect((await a.query(api.agent.claimable, {})).next).toBe(jobs[0]);
		expect((await b.query(api.agent.claimable, {})).next).toBe(jobs[0]);
		const claims = await Promise.all([
			a.mutation(api.agent.claimNext, {}),
			b.mutation(api.agent.claimNext, {}),
			a.mutation(api.agent.claimNext, {}),
			b.mutation(api.agent.claimNext, {}),
		]);
		const claimed = claims.flatMap((claim) => (claim ? [claim.jobId] : []));
		expect(claimed.sort()).toEqual([...jobs].sort());
		expect(await a.query(api.agent.claimable, {})).toEqual({
			next: null,
			nextQuick: null,
		});
	});

	test("a job requeued after its lease expired is claimable again", async () => {
		const t = await seed();
		const a = asAgent(t, await addAgent(t));
		const b = asAgent(t, await addAgent(t));
		const jobId = await insertJob(t, { idempotent: true });
		await a.mutation(api.agent.claimNext, {});
		expect((await b.query(api.agent.claimable, {})).next).toBeNull();
		await t.run(async (ctx) => {
			const lease = await ctx.db
				.query("jobLeases")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique();
			if (lease) {
				await ctx.db.patch("jobLeases", lease._id, {
					expiresAt: Date.now() - LEASE_MS,
				});
			}
		});
		await t.mutation(internal.jobs.reapExpiredLeases, {});
		expect((await b.query(api.agent.claimable, {})).next).toBe(jobId);
		expect((await b.mutation(api.agent.claimNext, {}))?.jobId).toBe(jobId);
	});

	test("needs an enrolled agent", async () => {
		const t = await seed();
		await expect(
			asUser(t, "alice").query(api.agent.claimable, {}),
		).rejects.toThrow("Agent authentication required");
		await expect(
			asUser(t, "alice").query(api.agent.cancelRequests, {}),
		).rejects.toThrow("Agent authentication required");
	});
});

describe("the cancel requests the agent waits on", () => {
	test("list this agent's running jobs whose cancel was asked for", async () => {
		const t = await seed();
		const agentA = await addAgent(t);
		const a = asAgent(t, agentA);
		const b = asAgent(t, await addAgent(t));
		const jobId = await insertJob(t, { group: "application:a" });
		const other = await insertJob(t, { group: "application:b" });
		const claim = await a.mutation(api.agent.claimNext, {});
		const otherClaim = await b.mutation(api.agent.claimNext, {});
		if (!claim || !otherClaim) throw new Error("expected claims");
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([]);

		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId });
		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId: other });
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([jobId]);
		expect(await b.query(api.agent.cancelRequests, {})).toEqual([other]);

		// A heartbeat renewing the lease meanwhile still reports it, and
		// changes nothing the subscription reads.
		expect(
			await a.mutation(api.agent.heartbeat, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).toEqual({ cancelRequested: true });
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([jobId]);

		await a.mutation(api.agent.fail, {
			jobId,
			leaseId: claim.leaseId,
			error: "The operation was aborted",
		});
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([]);
		expect(
			await t.run((ctx) => ctx.db.get("jobs", jobId)).then((j) => j?.status),
		).toBe("cancelled");
	});

	test("a cancel racing a lease renewal is not lost", async () => {
		const t = await seed();
		const a = asAgent(t, await addAgent(t));
		const jobId = await insertJob(t);
		const claim = await a.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");
		const [beat] = await Promise.all([
			a.mutation(api.agent.heartbeat, { jobId, leaseId: claim.leaseId }),
			asUser(t, "alice").mutation(api.jobs.cancel, { jobId }),
		]);
		// Whichever ran first, the heartbeat renewed the lease and the cancel
		// stands for the subscription to deliver.
		expect(typeof beat.cancelRequested).toBe("boolean");
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([jobId]);
		const lease = await t.run((ctx) =>
			ctx.db
				.query("jobLeases")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique(),
		);
		expect(lease?.expiresAt).toBeGreaterThan(Date.now());
	});

	test("a job reclaimed by another agent after its lease expired leaves the first agent's list", async () => {
		const t = await seed();
		const a = asAgent(t, await addAgent(t));
		const b = asAgent(t, await addAgent(t));
		const jobId = await insertJob(t, { idempotent: true });
		await a.mutation(api.agent.claimNext, {});
		await t.run(async (ctx) => {
			const lease = await ctx.db
				.query("jobLeases")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique();
			if (lease) await ctx.db.delete("jobLeases", lease._id);
			await ctx.db.patch("jobs", jobId, {
				status: "queued",
				claimedBy: undefined,
				startedAt: undefined,
			});
		});
		await b.mutation(api.agent.claimNext, {});
		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId });
		expect(await a.query(api.agent.cancelRequests, {})).toEqual([]);
		expect(await b.query(api.agent.cancelRequests, {})).toEqual([jobId]);
	});
});
