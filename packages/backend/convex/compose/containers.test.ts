import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const container = (fields: Record<string, unknown>) => ({
	containerId: "abc",
	name: "x",
	image: "nginx",
	ports: "",
	state: "running",
	status: "Up",
	created: 0,
	service: null,
	composeProject: null,
	...fields,
});

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const serverId = await alice.mutation(api.servers.create, {
		organizationId: "org1",
		name: "edge",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		serverType: "deploy",
		enableDockerCleanup: false,
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		serverId,
		name: "Web stack",
		composeFile: "services:\n  web:\n    image: nginx:alpine\n",
	});
	const compose = await alice.query(api.compose.crud.get, { composeId });
	const appName = compose?.appName as string;
	await grantMember(t, "org1", "bob", { services: [composeId] });
	return { t, alice, composeId, serverId, appName };
};

const writeSnapshot = (
	t: TestConvex,
	serverId: string,
	containers: ReturnType<typeof container>[],
) =>
	t.run(async (ctx) => {
		await ctx.db.insert("infraSnapshots", {
			organizationId: "org1",
			serverId: ctx.db.normalizeId("servers", serverId) ?? undefined,
			kind: "containers",
			data: JSON.stringify(containers),
			refreshedAt: 1,
		});
	});

describe("compose containers", () => {
	test("lists only this compose's containers, to members of its organization", async () => {
		const { t, composeId, serverId, appName } = await seed();
		await writeSnapshot(t, serverId, [
			container({ containerId: "c1", composeProject: appName }),
			container({ containerId: "c2", composeProject: "other-app" }),
		]);
		const result = await asUser(t, "bob").query(api.compose.containers.list, {
			composeId,
		});
		expect(result.containers.map((c) => c.containerId)).toEqual(["c1"]);
		expect(result.refreshedAt).toBe(1);
		await expect(
			asUser(t, "mallory").query(api.compose.containers.list, { composeId }),
		).rejects.toThrow(/Not a member/);
	});

	test("refresh queues one containers inspect on the compose's server", async () => {
		const { t, composeId, serverId } = await seed();
		const first = await asUser(t, "bob").mutation(
			api.compose.containers.refresh,
			{ composeId },
		);
		const second = await asUser(t, "bob").mutation(
			api.compose.containers.refresh,
			{ composeId },
		);
		expect(second).toBe(first);
		const job = await t.run((ctx) => ctx.db.get("jobs", first));
		expect(job?.partition).toBe(serverId);
		expect(job?.spec).toEqual({
			kind: "infra.inspect",
			serverId,
			what: "containers",
		});
	});

	test("actions need docker.read and a container of this compose", async () => {
		const { t, composeId, serverId, appName } = await seed();
		await writeSnapshot(t, serverId, [
			container({ containerId: "c1", composeProject: appName }),
			container({ containerId: "c2", composeProject: "other-app" }),
		]);
		await expect(
			asUser(t, "bob").mutation(api.compose.containers.runAction, {
				composeId,
				containerId: "c1",
				action: "restart",
			}),
		).rejects.toThrow(/docker\.read/);
		await grantMember(t, "org1", "bob", { flags: { canAccessToDocker: true } });
		await asUser(t, "bob").mutation(api.compose.containers.runAction, {
			composeId,
			containerId: "c1",
			action: "restart",
		});
		await grantMember(t, "org1", "bob", { services: [] });
		await expect(
			asUser(t, "bob").mutation(api.compose.containers.runAction, {
				composeId,
				containerId: "c1",
				action: "restart",
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "alice").mutation(api.compose.containers.runAction, {
				composeId,
				containerId: "c2",
				action: "restart",
			}),
		).rejects.toThrow(/not found/);
		const jobId = await asUser(t, "alice").mutation(
			api.compose.containers.runAction,
			{ composeId, containerId: "c1", action: "kill" },
		);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toEqual({
			kind: "infra.dockerAction",
			serverId,
			action: { type: "containerKill", containerId: "c1" },
		});
	});

	test("stack composes match their swarm services", async () => {
		const { t, alice, composeId, serverId, appName } = await seed();
		await alice.mutation(api.compose.crud.update, {
			composeId,
			composeType: "stack",
		});
		await writeSnapshot(t, serverId, [
			container({ containerId: "s1", service: `${appName}_web` }),
			container({ containerId: "s2", service: "other_web" }),
		]);
		const result = await alice.query(api.compose.containers.list, {
			composeId,
		});
		expect(result.containers.map((c) => c.containerId)).toEqual(["s1"]);
	});
});
