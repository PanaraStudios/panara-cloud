import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { enqueueJob } from "../lib/jobs";
import { LOCAL_PARTITION } from "../tables/core";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const setupInstance = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

describe("panel build slots", () => {
	test("instance admins read and set the panel host's concurrency", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		expect(
			await alice.query(api.infra.webServer.getLocalBuildsConcurrency),
		).toBe(1);
		await alice.mutation(api.infra.webServer.setLocalBuildsConcurrency, {
			buildsConcurrency: 3,
		});
		expect(
			await alice.query(api.infra.webServer.getLocalBuildsConcurrency),
		).toBe(3);
		await alice.mutation(api.infra.webServer.setLocalBuildsConcurrency, {
			buildsConcurrency: 4,
		});
		const rows = await t.run((ctx) =>
			ctx.db.query("instanceSettings").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.localBuildsConcurrency).toBe(4);
	});

	test("rejects members, other organizations and out-of-range values", async () => {
		const t = await setupInstance();
		for (const user of ["mallory", "eve"]) {
			await expect(
				asUser(t, user).mutation(
					api.infra.webServer.setLocalBuildsConcurrency,
					{ buildsConcurrency: 2 },
				),
			).rejects.toThrow(/instance administrator/);
			await expect(
				asUser(t, user).query(api.infra.webServer.getLocalBuildsConcurrency),
			).rejects.toThrow(/instance administrator/);
		}
		for (const value of [0, 101, 1.5]) {
			await expect(
				asUser(t, "alice").mutation(
					api.infra.webServer.setLocalBuildsConcurrency,
					{ buildsConcurrency: value },
				),
			).rejects.toThrow(/between 1 and 100/);
		}
	});
});

const queueJob = (
	t: TestConvex,
	organizationId: string,
	usesBuildSlot: boolean,
) =>
	t.run((ctx) =>
		enqueueJob(ctx, {
			organizationId,
			partition: LOCAL_PARTITION,
			group: `test:${Math.random()}`,
			spec: { kind: "noop", message: "x" },
			idempotent: false,
			usesBuildSlot,
		}),
	);

describe("deployment queue", () => {
	test("cancels only the organization's queued builds", async () => {
		const t = await setupInstance();
		const build = await queueJob(t, "org1", true);
		const quick = await queueJob(t, "org1", false);
		const other = await queueJob(t, "org2", true);
		const running = await queueJob(t, "org1", true);
		await t.run((ctx) => ctx.db.patch("jobs", running, { status: "running" }));

		const cancelled = await asUser(t, "alice").mutation(
			api.infra.cleanup.cancelQueuedDeployments,
			{ organizationId: "org1" },
		);
		expect(cancelled).toBe(1);
		const status = async (id: typeof build) =>
			(await t.run((ctx) => ctx.db.get("jobs", id)))?.status;
		expect(await status(build)).toBe("cancelled");
		expect(await status(quick)).toBe("queued");
		expect(await status(other)).toBe("queued");
		expect(await status(running)).toBe("running");
	});

	test("requires an admin of the organization", async () => {
		const t = await setupInstance();
		await queueJob(t, "org1", true);
		for (const user of ["mallory", "eve"]) {
			await expect(
				asUser(t, user).mutation(api.infra.cleanup.cancelQueuedDeployments, {
					organizationId: "org1",
				}),
			).rejects.toThrow();
		}
	});
});
