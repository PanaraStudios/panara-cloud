import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	addServer,
	asUser,
	grantMember,
	setup,
} from "../test.setup";

const zip = () => new Blob([new Uint8Array(16)], { type: "application/zip" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("drop deployments", () => {
	test("only take a zip uploaded through the caller's URL for that app", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		const bob = asUser(t, "bob");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const serverId = await addServer(t, "org1");
		const create = (name: string) =>
			alice.mutation(api.applications.applications.create, {
				environmentId,
				name,
				serverId,
			});
		const mine = await create("mine");
		const other = await create("other");
		await grantMember(t, "org1", "bob", { services: [mine] });

		await alice.mutation(api.applications.deploy.generateDropUploadUrl, {
			applicationId: other,
		});
		const aliceZip = await t.run((ctx) => ctx.storage.store(zip()));
		await alice.mutation(api.applications.deploy.dropDeploy, {
			applicationId: other,
			storageId: aliceZip,
		});
		await tick();
		await bob.mutation(api.applications.deploy.generateDropUploadUrl, {
			applicationId: mine,
		});
		await expect(
			bob.mutation(api.applications.deploy.dropDeploy, {
				applicationId: mine,
				storageId: aliceZip,
			}),
		).rejects.toThrow(/Upload not found/);
		const bobZip = await t.run((ctx) => ctx.storage.store(zip()));
		expect(
			await bob.mutation(api.applications.deploy.dropDeploy, {
				applicationId: mine,
				storageId: bobZip,
			}),
		).toBeTruthy();
	});
});
