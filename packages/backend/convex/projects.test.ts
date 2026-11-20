import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { addMember, asUser, grantMember, setup } from "./test.setup";

describe("projects", () => {
	test("admin creates a project with a default production environment", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const { projectId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "  Shop  ",
		});
		const projects = await alice.query(api.projects.list, {
			organizationId: "org1",
		});
		expect(projects.map((p) => p.name)).toEqual(["Shop"]);
		const environments = await alice.query(api.environments.list, {
			projectId,
		});
		expect(environments).toMatchObject([
			{ name: "production", isDefault: true },
		]);
	});

	test("members read the projects they were given and create only when allowed; outsiders can do neither", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		const { projectId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const bob = asUser(t, "bob");
		await expect(
			bob.query(api.projects.list, { organizationId: "org1" }),
		).resolves.toHaveLength(0);
		expect(await bob.query(api.projects.get, { projectId })).toBeNull();
		await grantMember(t, "org1", "bob", { projects: [projectId] });
		await expect(
			bob.query(api.projects.list, { organizationId: "org1" }),
		).resolves.toHaveLength(1);
		await expect(
			bob.mutation(api.projects.create, {
				organizationId: "org1",
				name: "Nope",
			}),
		).rejects.toThrow(/project.create permission/);
		await grantMember(t, "org1", "bob", {
			flags: { canCreateProjects: true },
		});
		const created = await bob.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Mine",
		});
		const all = await bob.query(api.projects.all, { organizationId: "org1" });
		expect(all.map((p) => p.name).sort()).toEqual(["Mine", "Shop"]);
		expect(
			all.find((p) => p.projectId === created.projectId)?.environments,
		).toHaveLength(1);
		await expect(
			bob.mutation(api.projects.remove, { projectId: created.projectId }),
		).rejects.toThrow(/project.delete permission/);
		await expect(
			asUser(t, "mallory").query(api.projects.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.query(api.projects.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not authenticated/);
	});

	test("a project from another org is not readable", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org2", "mallory", "owner");
		const { projectId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{
				organizationId: "org1",
				name: "Shop",
			},
		);
		await expect(
			asUser(t, "mallory").query(api.projects.get, { projectId }),
		).rejects.toThrow(/Not a member/);
	});

	test("removing a project deletes its environments", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { projectId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		await alice.mutation(api.projects.remove, { projectId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const remaining = await t.run((ctx) =>
			ctx.db.query("environments").collect(),
		);
		expect(remaining).toHaveLength(0);
		vi.useRealTimers();
	});

	test("environment names are unique per project and the default cannot be deleted", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{
				organizationId: "org1",
				name: "Shop",
			},
		);
		await expect(
			alice.mutation(api.environments.create, {
				projectId,
				name: "production",
			}),
		).rejects.toThrow(/already exists/);
		await expect(
			alice.mutation(api.environments.remove, { environmentId }),
		).rejects.toThrow(/default environment/);
	});

	test("all lists environments with their services and the project's tags", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop", description: "Store" },
		);
		await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Empty",
		});
		const staging = await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "web",
		});
		await alice.mutation(api.applications.applications.create, {
			environmentId: staging,
			name: "api",
		});
		const tagId = await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "prod",
		});
		await alice.mutation(api.platform.tags.setProjectTags, {
			projectId,
			tagIds: [tagId],
		});

		const projects = await alice.query(api.projects.all, {
			organizationId: "org1",
		});
		const shop = projects.find((p) => p.name === "Shop");
		expect(shop).toMatchObject({
			projectId,
			description: "Store",
			tags: [{ tagId, name: "prod" }],
		});
		const production = shop?.environments.find(
			(e) => e.environmentId === environmentId,
		);
		expect(production).toMatchObject({ name: "production", isDefault: true });
		expect(production?.services).toEqual([
			expect.objectContaining({ type: "compose", name: "web", status: "idle" }),
		]);
		expect(
			shop?.environments.find((e) => e.environmentId === staging)?.services,
		).toEqual([expect.objectContaining({ type: "application", name: "api" })]);
		expect(projects.find((p) => p.name === "Empty")).toMatchObject({
			description: null,
			tags: [],
		});
		await expect(
			asUser(t, "mallory").query(api.projects.all, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("environment page queries hide other organizations", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "bob", "admin");
		await addMember(t, "org2", "mallory", "owner");
		const { projectId, environmentId } = await asUser(t, "bob").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const webId = await asUser(t, "bob").mutation(api.compose.crud.create, {
			environmentId,
			name: "web",
		});
		await asUser(t, "bob").mutation(api.compose.crud.create, {
			environmentId,
			name: "hidden",
		});

		const alice = asUser(t, "alice");
		expect(
			await alice.query(api.environments.get, { environmentId }),
		).toBeNull();
		await grantMember(t, "org1", "alice", {
			projects: [projectId],
			environments: [environmentId],
			services: [webId],
		});
		expect(
			await alice.query(api.environments.get, { environmentId }),
		).toMatchObject({
			name: "production",
			project: { _id: projectId, name: "Shop" },
		});
		expect(
			await alice.query(api.environments.services, { environmentId }),
		).toEqual([
			expect.objectContaining({
				type: "compose",
				name: "web",
				serverName: null,
				lastDeployDate: null,
			}),
		]);

		const mallory = asUser(t, "mallory");
		expect(
			await mallory.query(api.environments.get, { environmentId }),
		).toBeNull();
		expect(
			await mallory.query(api.environments.services, { environmentId }),
		).toEqual([]);
	});

	test("duplicating an environment copies its variables, not its services", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "bob", "admin");
		const bob = asUser(t, "bob");
		const { environmentId } = await bob.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		await bob.action(api.environments.setEnv, {
			environmentId,
			env: "A=1",
		});
		await bob.mutation(api.compose.crud.create, {
			environmentId,
			name: "web",
		});

		await expect(
			asUser(t, "alice").mutation(api.environments.duplicate, {
				environmentId,
				name: "staging",
			}),
		).rejects.toThrow(/access to this environment/);
		await expect(
			bob.mutation(api.environments.duplicate, {
				environmentId,
				name: "production",
			}),
		).rejects.toThrow(/already exists/);

		const copyId = await bob.mutation(api.environments.duplicate, {
			environmentId,
			name: "staging",
		});
		expect(
			await bob.query(api.environments.getEnv, { environmentId: copyId }),
		).toBe("A=1");
		expect(
			await bob.query(api.environments.services, { environmentId: copyId }),
		).toEqual([]);
		expect(
			await bob.query(api.environments.get, { environmentId: copyId }),
		).toMatchObject({ name: "staging", isDefault: false });
	});

	test("members reach project and environment settings only inside their grants", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		const bob = asUser(t, "bob");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		await alice.action(api.projects.setEnv, { projectId, env: "P=1" });
		await alice.action(api.environments.setEnv, { environmentId, env: "E=1" });

		expect(await bob.query(api.projects.getEnv, { projectId })).toBeNull();
		expect(
			await bob.query(api.environments.getEnv, { environmentId }),
		).toBeNull();
		await expect(
			bob.action(api.projects.setEnv, { projectId, env: "P=0" }),
		).rejects.toThrow(/access to this project/);
		await expect(
			bob.mutation(api.projects.update, { projectId, name: "Renamed" }),
		).rejects.toThrow(/access to this project/);
		await expect(
			bob.mutation(api.environments.create, { projectId, name: "staging" }),
		).rejects.toThrow(/environment.create permission/);
		expect(await bob.query(api.environments.list, { projectId })).toEqual([]);

		await grantMember(t, "org1", "bob", {
			projects: [projectId],
			environments: [environmentId],
		});
		expect(await bob.query(api.projects.getEnv, { projectId })).toBe("P=1");
		await bob.action(api.projects.setEnv, { projectId, env: "P=2" });
		expect(await bob.query(api.environments.getEnv, { environmentId })).toBe(
			"E=1",
		);
		await bob.action(api.environments.setEnv, { environmentId, env: "E=2" });
		expect(await alice.query(api.environments.getEnv, { environmentId })).toBe(
			"E=2",
		);
		await bob.mutation(api.projects.update, { projectId, name: "Renamed" });
		await expect(
			bob.mutation(api.environments.create, { projectId, name: "staging" }),
		).rejects.toThrow(/environment.create permission/);

		await grantMember(t, "org1", "bob", {
			flags: { canCreateEnvironments: true },
		});
		const staging = await bob.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		const hidden = await alice.mutation(api.environments.create, {
			projectId,
			name: "qa",
		});
		expect(
			(await bob.query(api.environments.list, { projectId })).map((e) => e._id),
		).toEqual([environmentId, staging]);
		await expect(
			bob.mutation(api.environments.remove, { environmentId: staging }),
		).rejects.toThrow(/environment.delete permission/);
		await grantMember(t, "org1", "bob", {
			flags: { canCreateEnvironments: true, canDeleteEnvironments: true },
		});
		await expect(
			bob.mutation(api.environments.remove, { environmentId: hidden }),
		).rejects.toThrow(/access to this environment/);
		await bob.mutation(api.environments.remove, { environmentId: staging });
		expect(
			await alice.query(api.environments.list, { projectId }),
		).toHaveLength(2);
	});
});
