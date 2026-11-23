import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { LEASE_MS } from "./lib/jobs";
import { LOCAL_PARTITION } from "./schema";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "./test.setup";

const createServerWithKey = async (t: TestConvex, name = "web-1") => {
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "deploy key",
		publicKey: "ssh-ed25519 AAAAC3Nza test",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----",
	});
	const serverId = await alice.mutation(api.servers.create, {
		organizationId: "org1",
		name,
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup: true,
	});
	return { serverId, sshKeyId };
};

const enqueueNoop = (
	t: TestConvex,
	partition: string,
	group: string,
	idempotent = false,
	maxAttempts = 1,
	usesBuildSlot = true,
) =>
	t.run((ctx) =>
		ctx.db.insert("jobs", {
			organizationId: "org1",
			partition,
			group,
			spec: { kind: "noop", message: group },
			status: "queued",
			attempts: 0,
			maxAttempts,
			idempotent,
			usesBuildSlot,
			cancelRequested: false,
		}),
	);

describe("job queue", () => {
	test("server validation round trip: enqueue, claim, decrypt target, complete", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const { serverId } = await createServerWithKey(t);

		const jobId = await asUser(t, "alice").mutation(api.servers.validate, {
			serverId,
		});
		expect(await agent.query(api.agent.hasQueuedJobs, {})).toBe(true);

		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim).toMatchObject({
			jobId,
			spec: { kind: "server.validate", serverId },
			attempt: 1,
		});
		if (!claim) throw new Error("expected a claim");

		const target = await agent.query(api.agent.getJobTarget, {
			jobId,
			leaseId: claim.leaseId,
		});
		expect(target).toMatchObject({
			type: "ssh",
			host: "10.0.0.5",
			username: "root",
		});
		expect(target.type === "ssh" && target.privateKey).toContain(
			"secret-material",
		);

		await agent.mutation(api.agent.appendLogs, {
			jobId,
			leaseId: claim.leaseId,
			chunks: [
				{ seq: 0, text: "checking docker\n" },
				{ seq: 0, text: "duplicate is ignored\n" },
				{ seq: 1, text: "ok\n" },
			],
		});
		await agent.mutation(api.agent.complete, {
			jobId,
			leaseId: claim.leaseId,
			result: { kind: "server.validate", ok: true, details: "docker 29.8" },
		});
		// A retried completion must not throw or change anything.
		await agent.mutation(api.agent.complete, {
			jobId,
			leaseId: claim.leaseId,
			result: { kind: "server.validate", ok: true, details: "docker 29.8" },
		});

		const alice = asUser(t, "alice");
		expect(await alice.query(api.jobs.get, { jobId })).toMatchObject({
			status: "succeeded",
		});
		const logs = await alice.query(api.jobs.logs, { jobId });
		expect(logs.map((l) => l.text)).toEqual(["checking docker\n", "ok\n"]);
		expect(
			await alice.query(api.jobs.logs, { jobId, afterSeq: 0 }),
		).toHaveLength(1);
		expect(await alice.query(api.servers.get, { serverId })).toMatchObject({
			lastValidation: { ok: true, details: "docker 29.8" },
		});
		expect(
			await t.run((ctx) => ctx.db.query("jobLeases").collect()),
		).toHaveLength(0);
	});

	test("encrypted private key is never stored or listed in plaintext", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await createServerWithKey(t);
		const secrets = await t.run((ctx) => ctx.db.query("secrets").collect());
		expect(JSON.stringify(secrets)).not.toContain("secret-material");
		const keys = await asUser(t, "alice").query(api.sshKeys.list, {
			organizationId: "org1",
		});
		expect(JSON.stringify(keys)).not.toContain("PRIVATE KEY");
	});

	test("quickOnly claims skip everything but short interactive reads", async () => {
		const t = setup();
		const agent = asAgent(t, await addAgent(t));
		const deploy = await enqueueNoop(
			t,
			LOCAL_PARTITION,
			"app:a",
			false,
			1,
			false,
		);
		const inspect = await t.run((ctx) =>
			ctx.db.insert("jobs", {
				organizationId: "org1",
				partition: LOCAL_PARTITION,
				group: "inspect:local:containers",
				spec: { kind: "infra.inspect", what: "containers" },
				status: "queued",
				attempts: 0,
				maxAttempts: 1,
				idempotent: true,
				usesBuildSlot: false,
				cancelRequested: false,
			}),
		);
		const quick = await agent.mutation(api.agent.claimNext, {
			quickOnly: true,
		});
		expect(quick?.jobId).toBe(inspect);
		expect(
			await agent.mutation(api.agent.claimNext, { quickOnly: true }),
		).toBeNull();
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(deploy);
	});

	test("respects per-server concurrency and serializes jobs of the same service", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const { serverId } = await createServerWithKey(t);

		const a1 = await enqueueNoop(t, serverId, "app:a");
		const a2 = await enqueueNoop(t, serverId, "app:a");
		const b1 = await enqueueNoop(t, serverId, "app:b");

		const first = await agent.mutation(api.agent.claimNext, {});
		expect(first?.jobId).toBe(a1);
		// Concurrency is 1 for this server, so nothing else may start.
		expect(await agent.mutation(api.agent.claimNext, {})).toBeNull();

		await asUser(t, "alice").mutation(api.servers.setBuildsConcurrency, {
			serverId,
			buildsConcurrency: 2,
		});
		// a2 is blocked by a1 (same service), so b1 is next.
		const second = await agent.mutation(api.agent.claimNext, {});
		expect(second?.jobId).toBe(b1);
		expect(await agent.mutation(api.agent.claimNext, {})).toBeNull();

		if (!first) throw new Error("expected a claim");
		await agent.mutation(api.agent.complete, {
			jobId: a1,
			leaseId: first.leaseId,
			result: { kind: "none" },
		});
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(a2);
	});

	test("quick jobs don't wait for build slots", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const { serverId } = await createServerWithKey(t);
		const build = await enqueueNoop(t, serverId, "app:a");
		const buildQueued = await enqueueNoop(t, serverId, "app:b");
		const inspect = await enqueueNoop(t, serverId, "inspect", false, 1, false);

		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(build);
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(
			inspect,
		);
		expect(await agent.mutation(api.agent.claimNext, {})).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("jobs", buildQueued))).toMatchObject(
			{
				status: "queued",
			},
		);
	});

	test("a stale lease cannot report on a job", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const jobId = await enqueueNoop(t, "local", "x");
		await agent.mutation(api.agent.claimNext, {});
		await expect(
			agent.mutation(api.agent.heartbeat, { jobId, leaseId: "wrong" }),
		).rejects.toThrow(/Lease lost/);
		await expect(
			agent.mutation(api.agent.appendLogs, {
				jobId,
				leaseId: "wrong",
				chunks: [{ seq: 0, text: "x" }],
			}),
		).rejects.toThrow(/Lease lost/);
	});

	test("expired leases requeue idempotent jobs, then fail them after max attempts", async () => {
		vi.useFakeTimers();
		const t = setup();
		const agent = asAgent(t, await addAgent(t));
		const jobId = await enqueueNoop(t, "local", "x", true, 2);

		await agent.mutation(api.agent.claimNext, {});
		vi.setSystemTime(Date.now() + LEASE_MS * 2);
		await t.mutation(internal.jobs.reapExpiredLeases, {});
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			status: "queued",
			attempts: 1,
		});

		await agent.mutation(api.agent.claimNext, {});
		vi.setSystemTime(Date.now() + LEASE_MS * 2);
		await t.mutation(internal.jobs.reapExpiredLeases, {});
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			status: "failed",
			attempts: 2,
			error: expect.stringContaining("lease expired"),
		});
		vi.useRealTimers();
	});

	test("release requeues idempotent jobs and fails the others with the reason", async () => {
		const t = setup();
		const agent = asAgent(t, await addAgent(t));
		const retryable = await enqueueNoop(t, "local", "a", true, 2);
		const oneShot = await enqueueNoop(t, "local", "b", false, 1, false);

		const first = await agent.mutation(api.agent.claimNext, {});
		const second = await agent.mutation(api.agent.claimNext, {});
		if (!first || !second) throw new Error("expected two claims");
		const reason = "Agent restarted before the job finished";
		for (const claim of [first, second]) {
			await agent.mutation(api.agent.release, {
				jobId: claim.jobId,
				leaseId: claim.leaseId,
				reason,
			});
		}
		expect(await t.run((ctx) => ctx.db.get("jobs", retryable))).toMatchObject({
			status: "queued",
			attempts: 1,
		});
		expect(await t.run((ctx) => ctx.db.get("jobs", oneShot))).toMatchObject({
			status: "failed",
			error: reason,
		});
		const leases = await t.run((ctx) => ctx.db.query("jobLeases").collect());
		expect(leases).toHaveLength(0);
		await expect(
			agent.mutation(api.agent.heartbeat, {
				jobId: first.jobId,
				leaseId: first.leaseId,
			}),
		).rejects.toThrow(/Lease lost/);
		expect(await agent.mutation(api.agent.claimNext, {})).toMatchObject({
			jobId: retryable,
			attempt: 2,
		});
	});

	test("heartbeat extends the lease and reports cancellation", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agent = asAgent(t, await addAgent(t));
		const jobId = await enqueueNoop(t, "local", "x");
		const claim = await agent.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");

		vi.setSystemTime(Date.now() + LEASE_MS - 1000);
		expect(
			await agent.mutation(api.agent.heartbeat, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).toEqual({ cancelRequested: false });
		vi.setSystemTime(Date.now() + LEASE_MS - 1000);
		await t.mutation(internal.jobs.reapExpiredLeases, {});
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			status: "running",
		});

		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId });
		expect(
			await agent.mutation(api.agent.heartbeat, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).toEqual({ cancelRequested: true });
		await agent.mutation(api.agent.fail, {
			jobId,
			leaseId: claim.leaseId,
			error: "cancelled by user",
		});
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			status: "cancelled",
		});
		vi.useRealTimers();
	});

	test("only agents can use the agent API, and agents cannot act as users", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const agentId = await addAgent(t);
		await expect(
			asUser(t, "alice").mutation(api.agent.claimNext, {}),
		).rejects.toThrow(/Agent authentication required/);
		await expect(t.query(api.agent.hasQueuedJobs, {})).rejects.toThrow(
			/Agent authentication required/,
		);
		await expect(
			asAgent(t, agentId).query(api.projects.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not authenticated/);
		await t.run((ctx) =>
			ctx.db.patch("agents", agentId as Id<"agents">, { disabled: true }),
		);
		await expect(
			asAgent(t, agentId).query(api.agent.hasQueuedJobs, {}),
		).rejects.toThrow(/not enrolled/);
	});
});

describe("member access to jobs", () => {
	test("members read and cancel the jobs of services they were given", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "mallory", "member");
		await addMember(t, "org2", "eve", "owner");
		const serviceJob = await enqueueNoop(t, "local", "application:app1");
		const hostJob = await enqueueNoop(t, "local", "server:web");
		const mallory = asUser(t, "mallory");
		const history = {
			organizationId: "org1",
			target: { kind: "application", id: "app1" },
		};

		await expect(
			mallory.query(api.jobs.get, { jobId: serviceJob }),
		).rejects.toThrow(/access to this job/);
		await expect(
			mallory.query(api.jobs.logs, { jobId: serviceJob }),
		).rejects.toThrow(/access to this job/);
		await expect(
			mallory.mutation(api.jobs.cancel, { jobId: serviceJob }),
		).rejects.toThrow(/access to this job/);
		await expect(mallory.query(api.jobs.deployments, history)).rejects.toThrow(
			/access to this history/,
		);
		expect(
			await mallory.query(api.jobs.listRecent, { organizationId: "org1" }),
		).toEqual([]);

		await grantMember(t, "org1", "mallory", { services: ["app1"] });
		expect(
			await mallory.query(api.jobs.get, { jobId: serviceJob }),
		).toMatchObject({ group: "application:app1" });
		expect(await mallory.query(api.jobs.deployments, history)).toEqual([]);
		expect(
			(
				await mallory.query(api.jobs.listRecent, { organizationId: "org1" })
			).map((job) => job._id),
		).toEqual([serviceJob]);
		await mallory.mutation(api.jobs.cancel, { jobId: serviceJob });
		expect((await t.run((ctx) => ctx.db.get("jobs", serviceJob)))?.status).toBe(
			"cancelled",
		);

		await expect(
			mallory.mutation(api.jobs.cancel, { jobId: hostJob }),
		).rejects.toThrow(/access to this job/);
		await expect(
			mallory.query(api.jobs.deployments, {
				organizationId: "org1",
				target: { kind: "server", id: "web" },
			}),
		).rejects.toThrow(/access to this history/);
		await expect(
			asUser(t, "eve").query(api.jobs.get, { jobId: serviceJob }),
		).rejects.toThrow(/Not a member/);
		await asUser(t, "alice").mutation(api.jobs.cancel, { jobId: hostJob });
	});
});
