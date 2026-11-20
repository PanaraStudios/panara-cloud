import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const { environmentId } = await asUser(t, "alice").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const databaseId = await asUser(t, "alice").action(
		api.databases.databases.create,
		{ environmentId, engine: "redis", name: "cache" },
	);
	return { t, databaseId };
};

describe("database member rights", () => {
	test("a member given the database runs its lifecycle, env and mounts", async () => {
		const { t, databaseId } = await seed();
		const bob = asUser(t, "bob");
		await expect(
			bob.mutation(api.databases.databases.start, { databaseId }),
		).rejects.toThrow(/access to this service/);
		expect(
			await bob.query(api.databases.databases.listForOrganization, {
				organizationId: "org1",
			}),
		).toHaveLength(0);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		await bob.mutation(api.databases.databases.deploy, { databaseId });
		await bob.mutation(api.databases.databases.reload, { databaseId });
		await bob.action(api.databases.databases.setEnv, {
			databaseId,
			env: "A=1",
		});
		expect(
			await bob.query(api.databases.databases.getEnv, { databaseId }),
		).toBe("A=1");
		const mountId = await bob.mutation(
			api.databases.databases.addDatabaseMount,
			{
				databaseId,
				mount: { type: "volume", volumeName: "x-data", mountPath: "/x" },
			},
		);
		await bob.mutation(api.databases.databases.removeDatabaseMount, {
			mountId,
		});
		expect(
			await bob.query(api.databases.databases.deployments, { databaseId }),
		).toHaveLength(1);
		expect(
			await bob.query(api.databases.databases.listForOrganization, {
				organizationId: "org1",
			}),
		).toHaveLength(1);
		await expect(
			bob.mutation(api.databases.databases.saveExternalPort, {
				databaseId,
				externalPort: 6390,
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "eve").mutation(api.databases.databases.deploy, { databaseId }),
		).rejects.toThrow(/Not a member/);
	});
});
