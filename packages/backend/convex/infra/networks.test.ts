import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const setupInstance = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

const dockerNetworks = [
	{
		id: "aaaaaaaaaaaa",
		name: "shared",
		driver: "overlay",
		scope: "swarm",
		internal: false,
		attachable: true,
		subnets: ["10.20.0.0/24"],
	},
	{
		id: "bbbbbbbbbbbb",
		name: "recreated",
		driver: "bridge",
		scope: "local",
		internal: true,
		attachable: false,
		subnets: [],
	},
	{
		id: "cccccccccccc",
		name: "panara-cloud-network",
		driver: "overlay",
		scope: "swarm",
		internal: false,
		attachable: true,
		subnets: [],
	},
	{
		id: "dddddddddddd",
		name: "macvlan-net",
		driver: "macvlan",
		scope: "local",
		internal: false,
		attachable: false,
		subnets: [],
	},
];

const seed = async (t: TestConvex) => {
	await t.run(async (ctx) => {
		await ctx.db.insert("infraSnapshots", {
			organizationId: "org1",
			kind: "networks",
			data: JSON.stringify(dockerNetworks),
			refreshedAt: 1,
		});
		const base = {
			organizationId: "org1",
			internal: false,
			attachable: true,
			enableIPv4: true,
			enableIPv6: false,
		};
		await ctx.db.insert("networks", {
			...base,
			name: "recreated",
			driver: "bridge",
			dockerId: "ffffffffffff0000",
			status: "created",
		});
		await ctx.db.insert("networks", {
			...base,
			name: "gone",
			driver: "overlay",
			dockerId: "eeeeeeeeeeee",
			status: "created",
		});
	});
};

describe("network sync", () => {
	test("compares tracked networks with the host's Docker networks", async () => {
		const t = await setupInstance();
		await seed(t);
		const alice = asUser(t, "alice");
		const sync = await alice.query(api.infra.networks.toSync, {
			organizationId: "org1",
		});
		expect(sync.importable.map((n) => n.name)).toEqual(["shared"]);
		expect(sync.missing.map((n) => n.name)).toEqual(["gone"]);
		expect(sync.changed.map((n) => n.name)).toEqual(["recreated"]);

		await expect(
			asUser(t, "mallory").query(api.infra.networks.toSync, {
				organizationId: "org1",
			}),
		).rejects.toThrow();
		await expect(
			asUser(t, "eve").query(api.infra.networks.toSync, {
				organizationId: "org2",
			}),
		).rejects.toThrow(/instance administrator/);
	});

	test("imports, resyncs and recreates networks", async () => {
		const t = await setupInstance();
		await seed(t);
		const alice = asUser(t, "alice");
		const result = await alice.mutation(api.infra.networks.importDocker, {
			organizationId: "org1",
			names: [
				"shared",
				"recreated",
				"panara-cloud-network",
				"macvlan-net",
				"nope",
			],
		});
		expect(result.imported).toEqual(["shared"]);
		expect(result.errors.map((e) => [e.name, e.error])).toEqual([
			["recreated", "Already imported"],
			["panara-cloud-network", "Network is reserved or not supported"],
			["macvlan-net", "Network is reserved or not supported"],
			["nope", "Network not found"],
		]);
		const rows = await alice.query(api.infra.networks.list, {
			organizationId: "org1",
		});
		const shared = rows.find((row) => row.name === "shared");
		expect(shared).toMatchObject({
			driver: "overlay",
			dockerId: "aaaaaaaaaaaa",
			status: "created",
			ipam: { config: [{ subnet: "10.20.0.0/24" }] },
		});

		const recreated = rows.find((row) => row.name === "recreated");
		await alice.mutation(api.infra.networks.resync, {
			networkId: recreated?._id as Id<"networks">,
		});
		const sync = await alice.query(api.infra.networks.toSync, {
			organizationId: "org1",
		});
		expect(sync.changed).toEqual([]);

		const gone = rows.find((row) => row.name === "gone");
		await expect(
			alice.mutation(api.infra.networks.resync, {
				networkId: gone?._id as Id<"networks">,
			}),
		).rejects.toThrow(/does not exist/);
		const jobId = await alice.mutation(api.infra.networks.recreate, {
			networkId: gone?._id as Id<"networks">,
		});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toMatchObject({
			kind: "infra.dockerAction",
			action: { type: "networkCreate", networkId: gone?._id },
		});
		await expect(
			asUser(t, "mallory").mutation(api.infra.networks.recreate, {
				networkId: gone?._id as Id<"networks">,
			}),
		).rejects.toThrow();
		await expect(
			asUser(t, "eve").mutation(api.infra.networks.importDocker, {
				organizationId: "org1",
				names: ["shared"],
			}),
		).rejects.toThrow();
	});
});
