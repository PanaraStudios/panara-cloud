import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addMember,
	addServer,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "web",
		composeFile: "services:\n  web:\n    image: nginx\n",
	});
	await alice.action(api.compose.crud.setEnv, { composeId, env: "TOKEN=abc" });
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "api" },
	);
	return { alice, projectId, environmentId, composeId, applicationId };
};

const servicesOf = (
	t: TestConvex,
	environmentId: Id<"environments">,
): Promise<{ type: string; name: string; id: string }[]> =>
	asUser(t, "alice").query(api.environments.services, { environmentId });

describe("project duplicate", () => {
	test("copies the selected services into the same environment", async () => {
		const t = setup();
		const { alice, environmentId, composeId } = await seed(t);
		const result = await alice.action(
			api.platform.projectTransferNode.duplicate,
			{
				sourceEnvironmentId: environmentId,
				name: "ignored",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: true,
			},
		);
		expect(result.environmentId).toBe(environmentId);
		const services = await servicesOf(t, environmentId);
		expect(services.map((s) => s.name).sort()).toEqual([
			"api",
			"web",
			"web (copy)",
		]);
		const copy = services.find((s) => s.name === "web (copy)");
		expect(
			await alice.query(api.compose.crud.getEnv, {
				composeId: copy?.id as Id<"compose">,
			}),
		).toBe("TOKEN=abc");
	});

	test("creates a new project with a production environment", async () => {
		const t = setup();
		const { alice, environmentId, applicationId, projectId } = await seed(t);
		const result = await alice.action(
			api.platform.projectTransferNode.duplicate,
			{
				sourceEnvironmentId: environmentId,
				name: "Shop 2",
				description: "copy",
				includeServices: true,
				selectedServices: [{ id: applicationId, type: "application" }],
				duplicateInSameProject: false,
			},
		);
		expect(result.projectId).not.toBe(projectId);
		expect(
			await alice.query(api.environments.get, {
				environmentId: result.environmentId,
			}),
		).toMatchObject({
			name: "production",
			isDefault: true,
			project: { name: "Shop 2", description: "copy" },
		});
		expect(
			(await servicesOf(t, result.environmentId)).map((s) => [s.type, s.name]),
		).toEqual([["application", "api"]]);
		expect((await servicesOf(t, environmentId)).length).toBe(2);
	});

	test("copies into another existing environment of the organization", async () => {
		const t = setup();
		const { alice, environmentId, composeId } = await seed(t);
		await addMember(t, "org2", "alice", "admin");
		const { environmentId: target } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Other" },
		);
		const result = await alice.action(
			api.platform.projectTransferNode.duplicate,
			{
				sourceEnvironmentId: environmentId,
				targetEnvironmentId: target,
				name: "ignored",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: true,
			},
		);
		expect(result.environmentId).toBe(target);
		expect((await servicesOf(t, target)).map((s) => s.name)).toEqual([
			"web (copy)",
		]);

		const { environmentId: foreign } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org2", name: "Foreign" },
		);
		await expect(
			alice.action(api.platform.projectTransferNode.duplicate, {
				sourceEnvironmentId: environmentId,
				targetEnvironmentId: foreign,
				name: "ignored",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: true,
			}),
		).rejects.toThrow(/Target environment not found/);
	});

	test("requires project.create and services from the source environment", async () => {
		const t = setup();
		const { alice, environmentId, projectId, composeId } = await seed(t);
		await expect(
			asUser(t, "bob").action(api.platform.projectTransferNode.duplicate, {
				sourceEnvironmentId: environmentId,
				name: "x",
				includeServices: false,
				selectedServices: [],
				duplicateInSameProject: false,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		const other = await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		await expect(
			alice.action(api.platform.projectTransferNode.duplicate, {
				sourceEnvironmentId: other,
				name: "x",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: true,
			}),
		).rejects.toThrow(/not found in this environment/);
	});

	test("members with project creation duplicate only services they were given", async () => {
		const t = setup();
		const { environmentId, composeId, applicationId } = await seed(t);
		await grantMember(t, "org1", "bob", {
			services: [composeId],
			flags: { canCreateProjects: true },
		});
		const bob = asUser(t, "bob");
		const serverId = await addServer(t, "org1");
		await t.run((ctx) => ctx.db.patch("compose", composeId, { serverId }));
		await expect(
			bob.action(api.platform.projectTransferNode.duplicate, {
				sourceEnvironmentId: environmentId,
				name: "Copy",
				includeServices: true,
				selectedServices: [{ id: applicationId, type: "application" }],
				duplicateInSameProject: false,
			}),
		).rejects.toThrow(/don't have access to this service/);
		await expect(
			bob.action(api.platform.projectTransferNode.duplicate, {
				sourceEnvironmentId: environmentId,
				name: "Copy",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: true,
			}),
		).rejects.toThrow(/don't have access to this project/);
		const result = await bob.action(
			api.platform.projectTransferNode.duplicate,
			{
				sourceEnvironmentId: environmentId,
				name: "Copy",
				includeServices: true,
				selectedServices: [{ id: composeId, type: "compose" }],
				duplicateInSameProject: false,
			},
		);
		const copied = await servicesOf(t, result.environmentId);
		expect(copied.map((service) => service.name)).toEqual(["web"]);
		const grants = await t.run((ctx) =>
			ctx.db
				.query("memberGrants")
				.withIndex("by_organizationId_and_userId", (q) =>
					q.eq("organizationId", "org1").eq("userId", "bob"),
				)
				.unique(),
		);
		expect(grants).toMatchObject({
			accessedProjects: [result.projectId],
			accessedEnvironments: [result.environmentId],
			accessedServices: [composeId, copied[0]?.id],
		});
	});
});
