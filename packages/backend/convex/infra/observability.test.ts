import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

describe("server health", () => {
	test("queues a health check with a log window and sums reservations", async () => {
		const t = await seed();
		const alice = asUser(t, "alice");
		const jobId = await alice.mutation(api.infra.docker.health, {
			sinceHours: 6,
		});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toMatchObject({
			kind: "infra.dockerAction",
			action: { type: "serverHealth", sinceHours: 6 },
		});
		await expect(
			alice.mutation(api.infra.docker.health, { sinceHours: 500 }),
		).rejects.toThrow(/between 1 and 168/);
		await expect(
			asUser(t, "mallory").mutation(api.infra.docker.health, {
				sinceHours: 24,
			}),
		).rejects.toThrow(/administrator|permission/);
		await expect(
			asUser(t, "eve").mutation(api.infra.docker.health, { sinceHours: 24 }),
		).rejects.toThrow(/administrator/);

		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "shop",
		});
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "web" },
		);
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "stack",
		});
		await t.run((ctx) =>
			ctx.db.patch("applications", applicationId as Id<"applications">, {
				memoryReservation: String(512 * 1024 * 1024),
				cpuReservation: "500000000",
			}),
		);
		expect(await alice.query(api.infra.docker.reservation, {})).toEqual({
			memoryReservedBytes: 512 * 1024 * 1024,
			cpuReservedNanoCpus: 500_000_000,
			appCount: 1,
			unsupportedComposeCount: 1,
		});
		await expect(
			asUser(t, "mallory").query(api.infra.docker.reservation, {}),
		).rejects.toThrow(/administrator/);
	});
});

describe("networks", () => {
	test("keeps the IPAM driver even without address config", async () => {
		const t = await seed();
		const alice = asUser(t, "alice");
		const networkId = await alice.mutation(api.infra.networks.create, {
			organizationId: "org1",
			name: "custom",
			driver: "bridge",
			ipamDriver: "default",
			ipamConfig: [],
		});
		const network = await t.run((ctx) =>
			ctx.db.get("networks", networkId as Id<"networks">),
		);
		expect(network?.ipam).toEqual({ driver: "default", config: [] });
		await expect(
			alice.mutation(api.infra.networks.create, {
				organizationId: "org1",
				name: "bad",
				driver: "bridge",
				ipamDriver: "x; rm -rf /",
			}),
		).rejects.toThrow(/IPAM driver/);
	});
});
