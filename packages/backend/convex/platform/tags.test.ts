import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

describe("tags", () => {
	test("admins manage tags; names are unique per org; members read", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const alice = asUser(t, "alice");
		const tagId = await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: " prod ",
			color: "#ff0000",
		});
		await expect(
			alice.mutation(api.platform.tags.create, {
				organizationId: "org1",
				name: "prod",
			}),
		).rejects.toThrow(/already exists/);
		await expect(
			alice.mutation(api.platform.tags.create, {
				organizationId: "org1",
				name: "x",
				color: "red;",
			}),
		).rejects.toThrow(/hex value/);
		await asUser(t, "mallory").mutation(api.platform.tags.create, {
			organizationId: "org2",
			name: "prod",
		});
		await expect(
			asUser(t, "bob").mutation(api.platform.tags.create, {
				organizationId: "org1",
				name: "dev",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		expect(
			await asUser(t, "bob").query(api.platform.tags.list, {
				organizationId: "org1",
			}),
		).toMatchObject([{ _id: tagId, name: "prod", color: "#ff0000" }]);
		await expect(
			asUser(t, "mallory").mutation(api.platform.tags.update, {
				tagId,
				name: "hijack",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("project tags: set, reject other org's tags, cascade on tag removal", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org2", "mallory", "owner");
		const alice = asUser(t, "alice");
		const { projectId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const prod = await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "prod",
		});
		const web = await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "web",
		});
		const foreign = await asUser(t, "mallory").mutation(
			api.platform.tags.create,
			{ organizationId: "org2", name: "x" },
		);
		await alice.mutation(api.platform.tags.setProjectTags, {
			projectId,
			tagIds: [prod, web, prod],
		});
		await alice.mutation(api.platform.tags.assignToProject, {
			projectId,
			tagId: web,
		});
		expect(
			(await alice.query(api.platform.tags.forProject, { projectId }))
				.map((tag) => tag.name)
				.sort(),
		).toEqual(["prod", "web"]);
		await expect(
			alice.mutation(api.platform.tags.assignToProject, {
				projectId,
				tagId: foreign,
			}),
		).rejects.toThrow(/Tag not found/);
		await expect(
			asUser(t, "mallory").mutation(api.platform.tags.assignToProject, {
				projectId,
				tagId: foreign,
			}),
		).rejects.toThrow(/Not a member/);

		await alice.mutation(api.platform.tags.remove, { tagId: prod });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await alice.query(api.platform.tags.projectTagMap, {
				organizationId: "org1",
			}),
		).toEqual({ [projectId]: [web] });
		vi.useRealTimers();
	});
});
