import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

describe("compose.one", () => {
	test("returns the compose with names; refresh token only for admins", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const alice = asUser(t, "alice");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Web stack",
			composeFile: "services:\n  web:\n    image: nginx:alpine\n",
		});

		const data = await alice.query(api.compose.crud.one, { composeId });
		expect(data).toMatchObject({
			_id: composeId,
			name: "Web stack",
			server: null,
			project: { _id: projectId, name: "Shop" },
			environment: { _id: environmentId },
		});
		expect(data?.refreshToken).toMatch(/^[A-Za-z0-9]{24}$/);

		await expect(
			asUser(t, "bob").query(api.compose.crud.one, { composeId }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [composeId] });
		const asMember = await asUser(t, "bob").query(api.compose.crud.one, {
			composeId,
		});
		expect(asMember?.refreshToken).toBeNull();
		await expect(
			asUser(t, "mallory").query(api.compose.crud.one, { composeId }),
		).rejects.toThrow(/Not a member/);
	});
});
