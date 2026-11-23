import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import {
	addMember,
	addServer,
	asApiKey,
	asUser,
	grantMember,
	setup,
} from "./test.setup";

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

	test("the navigation tree holds only what the caller was given, cut down to a row", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "eve", "owner");
		const alice = asUser(t, "alice");
		const bob = asUser(t, "bob");
		const shop = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const staging = await alice.mutation(api.environments.create, {
			projectId: shop.projectId,
			name: "staging",
		});
		const blog = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Blog",
		});
		const web = await alice.mutation(api.applications.applications.create, {
			environmentId: shop.environmentId,
			name: "web",
		});
		const apiId = await alice.mutation(api.applications.applications.create, {
			environmentId: shop.environmentId,
			name: "api",
		});
		const db = await alice.action(api.databases.databases.create, {
			environmentId: staging,
			engine: "postgres",
			name: "db",
		});
		await alice.mutation(api.applications.applications.create, {
			environmentId: blog.environmentId,
			name: "ghost",
		});
		await asUser(t, "eve").mutation(api.projects.create, {
			organizationId: "org2",
			name: "Elsewhere",
		});
		await alice.mutation(api.servers.create, {
			organizationId: "org1",
			name: "web-1",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			enableDockerCleanup: true,
		});

		const treeFor = (as: typeof alice) =>
			as.query(api.projects.navigationTree, { organizationId: "org1" });
		const names = (
			tree: Awaited<ReturnType<typeof treeFor>>,
		): Record<string, Record<string, string[]>> =>
			Object.fromEntries(
				tree.projects.map((project) => [
					project.name,
					Object.fromEntries(
						project.environments.map((environment) => [
							environment.name,
							environment.services.map((service) => service.name),
						]),
					),
				]),
			);
		const full = await treeFor(alice);
		expect(names(full)).toEqual({
			Shop: { production: ["web", "api"], staging: ["db"] },
			Blog: { production: ["ghost"] },
		});
		expect(full.servers?.map((server) => server.name)).toEqual(["web-1"]);
		const row = full.projects[0]?.environments[0]?.services[0];
		expect(row).toEqual({
			id: web,
			type: "application",
			name: "web",
			icon: null,
			status: "idle",
			runtime: { deployState: "never", activity: null },
		});
		expect(Object.keys(full.projects[0] ?? {}).sort()).toEqual([
			"environments",
			"name",
			"projectId",
		]);

		expect(names(await treeFor(bob))).toEqual({});
		await grantMember(t, "org1", "bob", { projects: [shop.projectId] });
		expect(names(await treeFor(bob))).toEqual({ Shop: {} });
		await grantMember(t, "org1", "bob", {
			environments: [shop.environmentId, staging],
			services: [apiId],
		});
		const given = await treeFor(bob);
		expect(names(given)).toEqual({
			Shop: { production: ["api"], staging: [] },
		});
		expect(given.servers).toBeNull();
		// The same projects and services the Projects page lists for him.
		const page = await bob.query(api.projects.all, { organizationId: "org1" });
		expect(
			page.map((project) => [
				project.projectId,
				project.environments.map((environment) => [
					environment.environmentId,
					environment.services.map((service) => service.id),
				]),
			]),
		).toEqual(
			given.projects.map((project) => [
				project.projectId,
				project.environments.map((environment) => [
					environment.environmentId,
					environment.services.map((service) => service.id),
				]),
			]),
		);
		await grantMember(t, "org1", "bob", { services: [apiId, db] });
		expect(names(await treeFor(bob))).toEqual({
			Shop: { production: ["api"], staging: ["db"] },
		});

		await expect(
			asUser(t, "eve").query(api.projects.navigationTree, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.query(api.projects.navigationTree, { organizationId: "org1" }),
		).rejects.toThrow(/Not authenticated/);
	});

	test("the navigation tree's status facts agree with a service's own", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "web" },
		);
		const target = { kind: "application" as const, id: applicationId };
		const job = (status: "queued" | "running" | "succeeded", kind: string) =>
			t.run((ctx) =>
				ctx.db.insert("jobs", {
					organizationId: "org1",
					partition: "local",
					group: `application:${applicationId}`,
					spec: { kind, applicationId } as never,
					status,
					attempts: 0,
					maxAttempts: 1,
					idempotent: false,
					cancelRequested: false,
					startedAt: status === "queued" ? undefined : Date.now(),
				}),
			);
		const facts = async () => {
			const tree = await alice.query(api.projects.navigationTree, {
				organizationId: "org1",
			});
			const runtime = tree.projects[0]?.environments[0]?.services[0]?.runtime;
			const [own] = await alice.query(api.serviceEvents.pendingChangeCounts, {
				organizationId: "org1",
				targets: [target],
			});
			expect(runtime?.deployState).toBe(own?.deployState);
			expect(runtime?.activity).toEqual(
				own?.activity
					? { kind: own.activity.kind, status: own.activity.status }
					: null,
			);
			return runtime;
		};

		expect(await facts()).toEqual({ deployState: "never", activity: null });
		const queued = await job("queued", "application.deploy");
		expect(await facts()).toEqual({
			deployState: "deploying",
			activity: { kind: "deploying", status: "queued" },
		});
		await t.run((ctx) =>
			ctx.db.patch("jobs", queued, {
				status: "running",
				startedAt: Date.now(),
			}),
		);
		expect(await facts()).toEqual({
			deployState: "deploying",
			activity: { kind: "deploying", status: "running" },
		});
		await t.run((ctx) => ctx.db.patch("jobs", queued, { status: "succeeded" }));
		expect(await facts()).toEqual({ deployState: "deployed", activity: null });
		await job("running", "application.stop");
		expect(await facts()).toEqual({
			deployState: "deployed",
			activity: { kind: "stopping", status: "running" },
		});
	});
});

describe("deleting a project or an environment that still has services", () => {
	test("is refused, through the API too, until the services are deleted", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const key = asApiKey(t, "alice", "org1");
		const serverId = await addServer(t, "org1");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const staging = await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "web", serverId },
		);
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId: staging,
			name: "stack",
			serverId,
		});

		for (const caller of [alice, key]) {
			await expect(
				caller.mutation(api.projects.remove, { projectId }),
			).rejects.toThrow("This project still has services; delete them first");
			await expect(
				caller.mutation(api.environments.remove, { environmentId: staging }),
			).rejects.toThrow(
				"This environment still has services; delete them first",
			);
		}
		expect(
			await t.run((ctx) => ctx.db.get("projects", projectId)),
		).not.toBeNull();
		expect(
			await t.run((ctx) => ctx.db.get("applications", applicationId)),
		).not.toBeNull();

		await alice.mutation(api.compose.crud.remove, { composeId });
		await key.mutation(api.environments.remove, { environmentId: staging });
		await alice.mutation(api.applications.applications.remove, {
			applicationId,
		});
		await key.mutation(api.projects.remove, { projectId });
		expect(await t.run((ctx) => ctx.db.get("projects", projectId))).toBeNull();
	});
});
