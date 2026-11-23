import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { isAppNameInUse } from "./lib/appNames";
import { addMember, asUser, setup } from "./test.setup";

const COMPOSE_FILE = "services:\n  web:\n    image: nginx:alpine\n";

describe("cross-domain integration", () => {
	// The panel and the API refuse to delete an environment or a project that
	// still has services; deleting the organization cascades through them.
	test("the environment cascade removes its applications, compose services and databases", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { projectId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const environmentId = await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		await alice.mutation(api.applications.applications.create, {
			environmentId,
			name: "web",
		});
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "stack",
			composeFile: COMPOSE_FILE,
		});
		await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "postgres",
			name: "db",
		});

		await expect(
			alice.mutation(api.environments.remove, { environmentId }),
		).rejects.toThrow(/still has services/);
		await t.mutation(internal.projects.deleteEnvironments, { projectId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const remaining = await t.run(async (ctx) => ({
			applications: await ctx.db.query("applications").collect(),
			compose: await ctx.db.query("compose").collect(),
			databases: await ctx.db.query("databases").collect(),
			removeJobs: (await ctx.db.query("jobs").collect())
				.map((job) => job.spec.kind)
				.filter((kind) => kind.endsWith(".remove"))
				.sort(),
		}));
		expect(remaining.applications).toHaveLength(0);
		expect(remaining.compose).toHaveLength(0);
		expect(remaining.databases).toHaveLength(0);
		expect(remaining.removeJobs).toEqual([
			"application.remove",
			"compose.remove",
			"databases.remove",
		]);
		vi.useRealTimers();
	});

	test("a server that still runs services cannot be deleted", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const serverId = await alice.mutation(api.servers.create, {
			organizationId: "org1",
			name: "edge",
			ipAddress: "10.0.0.9",
			port: 22,
			username: "root",
			serverType: "deploy",
			enableDockerCleanup: false,
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			serverId,
			name: "stack",
			composeFile: COMPOSE_FILE,
		});
		await expect(
			alice.mutation(api.servers.remove, { serverId }),
		).rejects.toThrow(/still runs "stack"/);
		await alice.mutation(api.compose.crud.remove, { composeId });
		await alice.mutation(api.servers.remove, { serverId });
		expect(await t.run((ctx) => ctx.db.get("servers", serverId))).toBeNull();
	});

	test("app names are unique across service types", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "stack",
			composeFile: COMPOSE_FILE,
		});
		const compose = await t.run((ctx) => ctx.db.get("compose", composeId));
		if (!compose) throw new Error("compose missing");
		await t.run(async (ctx) => {
			expect(await isAppNameInUse(ctx, compose.appName)).toBe(true);
			expect(await isAppNameInUse(ctx, compose.appName, composeId)).toBe(false);
			expect(await isAppNameInUse(ctx, "unused-name")).toBe(false);
		});
	});
});
