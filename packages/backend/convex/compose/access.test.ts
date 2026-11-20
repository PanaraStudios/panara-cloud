import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const { environmentId } = await asUser(t, "alice").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const composeId = await asUser(t, "alice").mutation(api.compose.crud.create, {
		environmentId,
		name: "Web stack",
		composeFile: "services:\n  web:\n    image: nginx:alpine\n",
	});
	return { t, composeId };
};

describe("compose member rights", () => {
	test("a member given the service deploys, edits env and cancels", async () => {
		const { t, composeId } = await seed();
		const bob = asUser(t, "bob");
		await grantMember(t, "org1", "bob", { services: [composeId] });
		const { jobId } = await bob.mutation(api.compose.deploy.deploy, {
			composeId,
		});
		expect(
			await bob.query(api.compose.deploy.listDeployments, { composeId }),
		).toMatchObject([{ jobId }]);
		await bob.mutation(api.compose.deploy.stop, { composeId });
		await bob.action(api.compose.crud.setEnv, { composeId, env: "A=1" });
		expect(await bob.query(api.compose.crud.getEnv, { composeId })).toBe("A=1");
		expect(
			await bob.mutation(api.compose.deploy.killBuild, { composeId }),
		).toEqual({ cancelled: 0 });
		await expect(
			bob.mutation(api.compose.crud.regenerateRefreshToken, { composeId }),
		).rejects.toThrow(/service\.create/);
	});

	test("another member's grant doesn't reach this service; admins and other orgs unchanged", async () => {
		const { t, composeId } = await seed();
		await addMember(t, "org1", "carol", "member");
		await grantMember(t, "org1", "carol", { services: [composeId] });
		await expect(
			asUser(t, "bob").mutation(api.compose.deploy.redeploy, { composeId }),
		).rejects.toThrow(/access to this service/);
		await asUser(t, "alice").mutation(api.compose.deploy.redeploy, {
			composeId,
		});
		await grantMember(t, "org2", "eve", { services: [composeId] });
		await expect(
			asUser(t, "eve").mutation(api.compose.deploy.redeploy, { composeId }),
		).rejects.toThrow(/Not a member/);
	});
});
