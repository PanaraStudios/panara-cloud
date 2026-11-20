import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const PASSWORD = "S3cretPassw0rd";
const ROOT_PASSWORD = "R00tPassw0rd";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const { projectId, environmentId } = await asUser(t, "alice").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "shop" },
	);
	const databaseId = await asUser(t, "alice").action(
		api.databases.databases.create,
		{
			environmentId,
			engine: "mysql",
			name: "Orders",
			databasePassword: PASSWORD,
			databaseRootPassword: ROOT_PASSWORD,
		},
	);
	return { t, projectId, environmentId, databaseId };
};

describe("databases.one", () => {
	test("admins get the page data with passwords and names", async () => {
		const { t, projectId, environmentId, databaseId } = await seed();
		const data = await asUser(t, "alice").query(api.databases.databases.one, {
			databaseId,
		});
		expect(data).toMatchObject({
			_id: databaseId,
			engine: "mysql",
			name: "Orders",
			password: PASSWORD,
			rootPassword: ROOT_PASSWORD,
			server: null,
			project: { _id: projectId, name: "shop" },
			environment: { _id: environmentId },
		});
		expect(data?.mounts).toMatchObject([
			{ type: "volume", mountPath: "/var/lib/mysql" },
		]);
	});

	test("members see no passwords; other organizations are rejected", async () => {
		const { t, databaseId } = await seed();
		await expect(
			asUser(t, "bob").query(api.databases.databases.one, { databaseId }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const asMember = await asUser(t, "bob").query(api.databases.databases.one, {
			databaseId,
		});
		expect(asMember?.password).toBeNull();
		expect(asMember?.rootPassword).toBeNull();
		expect(JSON.stringify(asMember)).not.toContain(PASSWORD);
		await expect(
			asUser(t, "eve").query(api.databases.databases.one, { databaseId }),
		).rejects.toThrow(/Not a member/);
	});

	test("includes the remote server's name and address", async () => {
		const { t, environmentId } = await seed();
		const serverId = await asUser(t, "alice").mutation(api.servers.create, {
			organizationId: "org1",
			name: "edge",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			enableDockerCleanup: false,
		});
		const databaseId = await asUser(t, "alice").action(
			api.databases.databases.create,
			{ environmentId, serverId, engine: "redis", name: "cache" },
		);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const data = await asUser(t, "bob").query(api.databases.databases.one, {
			databaseId,
		});
		expect(data?.server).toEqual({
			_id: serverId,
			name: "edge",
			ipAddress: "10.0.0.5",
		});
		expect(data?.serverIp).toBe("10.0.0.5");
	});
});
