import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const addApplication = (
	t: TestConvex,
	environmentId: Id<"environments">,
	name: string,
) =>
	t.run(async (ctx) => {
		const environment = await ctx.db.get("environments", environmentId);
		return await ctx.db.insert("applications", {
			organizationId: environment?.organizationId ?? "",
			projectId: environment?.projectId as Id<"projects">,
			environmentId,
			name,
			appName: `app-${name}`,
			build: {
				type: "nixpacks",
				dockerfile: "Dockerfile",
				isStaticSpa: false,
				railpackVersion: "0.15.4",
				herokuVersion: "24",
				cleanCache: false,
				createEnvFile: true,
			},
			replicas: 1,
			autoDeploy: false,
			triggerType: "push",
			refreshToken: `token-${name}`,
			preview: {
				enabled: false,
				port: 3000,
				https: false,
				path: "/",
				certificateType: "none",
				limit: 3,
				labels: [],
				requireCollaboratorPermissions: true,
			},
			rollback: { enabled: false, keep: 5 },
			status: "idle",
		});
	});

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "olivia", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const { projectId, environmentId } = await asUser(t, "olivia").mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const web = await addApplication(t, environmentId, "web");
	const api_ = await addApplication(t, environmentId, "api");
	return { t, projectId, environmentId, web, api: api_ };
};

const scheduleArgs = (applicationId: Id<"applications">) => ({
	organizationId: "org1",
	target: { kind: "application" as const, applicationId },
	name: "cleanup",
	cronExpression: "0 3 * * *",
	shellType: "bash" as const,
	command: "rm -rf /tmp/cache",
	enabled: false,
});

describe("member schedules", () => {
	test("members manage and run schedules of the services they were given", async () => {
		const { t, web, api: other } = await seed();
		const bob = asUser(t, "bob");
		await expect(
			bob.mutation(api.platform.schedules.create, scheduleArgs(web)),
		).rejects.toThrow(/don't have access to this service/);
		await grantMember(t, "org1", "bob", { services: [web] });

		const scheduleId = await bob.mutation(
			api.platform.schedules.create,
			scheduleArgs(web),
		);
		expect(
			await bob.query(api.platform.schedules.list, {
				organizationId: "org1",
				kind: "application",
				targetId: web,
			}),
		).toHaveLength(1);
		await bob.mutation(api.platform.schedules.setEnabled, {
			scheduleId,
			enabled: true,
		});
		const jobId = await bob.mutation(api.platform.schedules.runNow, {
			scheduleId,
		});
		expect(jobId).not.toBeNull();

		await expect(
			bob.mutation(api.platform.schedules.create, scheduleArgs(other)),
		).rejects.toThrow(/don't have access to this service/);
		const hidden = await asUser(t, "olivia").mutation(
			api.platform.schedules.create,
			scheduleArgs(other),
		);
		await expect(
			bob.mutation(api.platform.schedules.runNow, { scheduleId: hidden }),
		).rejects.toThrow(/don't have access to this service/);
		await expect(
			bob.query(api.platform.schedules.get, { scheduleId: hidden }),
		).rejects.toThrow(/don't have access to this service/);
		const page = await bob.query(api.platform.schedules.listForOrganization, {
			organizationId: "org1",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(page.page.map((schedule) => schedule._id)).toEqual([scheduleId]);

		await expect(
			asUser(t, "mallory").mutation(api.platform.schedules.remove, {
				scheduleId,
			}),
		).rejects.toThrow(/Not a member/);
		await bob.mutation(api.platform.schedules.remove, { scheduleId });
	});
});

describe("member overview", () => {
	test("deployments and queue only list the member's services", async () => {
		const { t, web, api: other } = await seed();
		for (const applicationId of [web, other]) {
			await t.run(async (ctx) => {
				const jobId = await ctx.db.insert("jobs", {
					organizationId: "org1",
					partition: "local",
					group: `application:${applicationId}`,
					spec: { kind: "application.deploy", applicationId },
					status: "queued",
					attempts: 0,
					maxAttempts: 1,
					idempotent: false,
					cancelRequested: false,
				});
				await ctx.db.insert("deployments", {
					organizationId: "org1",
					jobId,
					target: { kind: "application", id: applicationId },
					title: "Deploy",
				});
			});
		}
		const owner = asUser(t, "olivia");
		expect(
			(
				await owner.query(api.platform.overview.deployments, {
					organizationId: "org1",
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page,
		).toHaveLength(2);
		expect(
			await owner.query(api.platform.overview.queue, {
				organizationId: "org1",
			}),
		).toHaveLength(2);

		await grantMember(t, "org1", "bob", { services: [web] });
		const bob = asUser(t, "bob");
		const deployments = await bob.query(api.platform.overview.deployments, {
			organizationId: "org1",
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(deployments.page.map((row) => row.service.id)).toEqual([web]);
		const queue = await bob.query(api.platform.overview.queue, {
			organizationId: "org1",
		});
		expect(queue.map((row) => row.service?.id)).toEqual([web]);
	});
});

describe("member tags", () => {
	test("members read tags and tag only their projects", async () => {
		const { t, projectId } = await seed();
		const tagId = await asUser(t, "olivia").mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "prod",
		});
		const bob = asUser(t, "bob");
		await expect(
			bob.query(api.platform.tags.list, { organizationId: "org1" }),
		).resolves.toHaveLength(1);
		await expect(
			bob.mutation(api.platform.tags.create, {
				organizationId: "org1",
				name: "mine",
			}),
		).rejects.toThrow(/tag\.create permission/);
		await expect(
			bob.mutation(api.platform.tags.assignToProject, { projectId, tagId }),
		).rejects.toThrow(/don't have access to this project/);
		await grantMember(t, "org1", "bob", { projects: [projectId] });
		await bob.mutation(api.platform.tags.assignToProject, { projectId, tagId });
		expect(
			await bob.query(api.platform.tags.projectTagMap, {
				organizationId: "org1",
			}),
		).toEqual({ [projectId]: [tagId] });
	});
});
