import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

describe("volume mounts of scoped members", () => {
	test("a member can't mount another service's volume", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const serverId = await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org1",
				name: "edge",
				ipAddress: "10.0.0.9",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "Web", serverId },
		);
		const other = await alice.mutation(api.applications.applications.create, {
			environmentId,
			name: "Billing",
			serverId,
		});
		const databaseId = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "postgres",
			name: "Main DB",
			databaseName: "shop",
			databaseUser: "shop",
			databasePassword: "pgpass",
			serverId,
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId: other,
			mount: { type: "volume", volumeName: "billing-files", mountPath: "/f" },
		});
		await grantMember(t, "org1", "bob", { services: [applicationId] });
		const appName = await t.run(
			async (ctx) => (await ctx.db.get("databases", databaseId))?.appName,
		);
		const bob = asUser(t, "bob");
		for (const volumeName of [`${appName}-data`, "billing-files"]) {
			await expect(
				bob.mutation(api.applications.mounts.create, {
					applicationId,
					mount: { type: "volume", volumeName, mountPath: "/steal" },
				}),
			).rejects.toThrow(/don't have access/);
		}
		await bob.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "web-cache", mountPath: "/cache" },
		});
		// Admins aren't scoped.
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: `${appName}-data`, mountPath: "/d" },
		});
	});
});
