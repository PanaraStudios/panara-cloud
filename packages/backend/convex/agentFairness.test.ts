import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { JOB_DEADLINE_MS } from "./agent";
import { enqueueJob, MAX_QUEUED_BUILDS_PER_ORG } from "./lib/jobs";
import {
	addAgent,
	addMember,
	asAgent,
	setup,
	type TestConvex,
} from "./test.setup";

// org1 is the root organization; org2 and org3 are tenants.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org2", "mallory", "owner");
	await addMember(t, "org3", "eve", "owner");
	return { t, agent: asAgent(t, await addAgent(t)) };
};

const insertJob = (
	t: TestConvex,
	organizationId: string,
	group: string,
	fields: { status?: "queued" | "running"; startedAt?: number } = {},
) =>
	t.run((ctx) =>
		ctx.db.insert("jobs", {
			organizationId,
			partition: `srv-${organizationId}`,
			group,
			spec: { kind: "noop", message: group },
			status: fields.status ?? "queued",
			startedAt: fields.startedAt,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			usesBuildSlot: false,
			cancelRequested: false,
		}),
	);

describe("the shared job queue", () => {
	test("waiting jobs of one organization don't hide others' behind them", async () => {
		const { t, agent } = await seed();
		await insertJob(t, "org2", "application:a", { status: "running" });
		for (let i = 0; i < 150; i++) await insertJob(t, "org2", "application:a");
		const other = await insertJob(t, "org3", "application:b");
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(other);
	});

	test("an organization runs at most its share of the agent's slots", async () => {
		const { t, agent } = await seed();
		await insertJob(t, "org2", "application:a", { status: "running" });
		await insertJob(t, "org2", "application:b", { status: "running" });
		await insertJob(t, "org2", "application:c");
		const other = await insertJob(t, "org3", "application:d");
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(other);
		expect(await agent.mutation(api.agent.claimNext, {})).toBeNull();
		// The root organization isn't capped.
		await insertJob(t, "org1", "application:r1", { status: "running" });
		await insertJob(t, "org1", "application:r2", { status: "running" });
		const root = await insertJob(t, "org1", "application:r3");
		expect((await agent.mutation(api.agent.claimNext, {}))?.jobId).toBe(root);
	});

	test("tenant jobs past their deadline are cancelled on the next heartbeat", async () => {
		const { t, agent } = await seed();
		const tenant = await insertJob(t, "org2", "application:a");
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(tenant);
		const beat = () =>
			agent.mutation(api.agent.heartbeat, {
				jobId: claim?.jobId as Id<"jobs">,
				leaseId: claim?.leaseId as string,
			});
		expect((await beat()).cancelRequested).toBe(false);
		await t.run((ctx) =>
			ctx.db.patch("jobs", tenant, {
				startedAt: Date.now() - JOB_DEADLINE_MS - 1,
			}),
		);
		expect((await beat()).cancelRequested).toBe(true);
	});

	test("an organization can't queue unbounded deployments", async () => {
		const { t } = await seed();
		const enqueue = (organizationId: string, i: number) =>
			t.run((ctx) =>
				enqueueJob(ctx, {
					organizationId,
					partition: `srv-${organizationId}`,
					group: `application:${i}`,
					spec: { kind: "noop", message: "x" },
					idempotent: false,
					usesBuildSlot: true,
				}),
			);
		for (let i = 0; i < MAX_QUEUED_BUILDS_PER_ORG; i++)
			await enqueue("org2", i);
		await expect(enqueue("org2", 999)).rejects.toThrow(/deployments waiting/);
		for (let i = 0; i < MAX_QUEUED_BUILDS_PER_ORG + 1; i++) {
			await enqueue("org1", i);
		}
	});
});
