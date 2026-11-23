import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	asUser,
	grantMember,
	markDeployed,
	setup,
} from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "ada", "admin");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Web" },
	);
	const create = (name: string) =>
		alice.mutation(api.applications.applications.create, {
			environmentId,
			name,
		});
	const applicationId = await create("Web");
	const otherId = await create("Api");
	await t.run((ctx) =>
		ctx.db.patch("applications", applicationId, {
			source: { type: "docker", image: "nginx:alpine" },
		}),
	);
	const serverId = await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId: "org1",
			name: "edge",
			ipAddress: "10.0.0.9",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		}),
	);
	return {
		t,
		alice,
		serverId,
		mallory: asUser(t, "mallory"),
		projectId,
		environmentId,
		applicationId,
		otherId,
	};
};

const fileMount = {
	type: "file" as const,
	filePath: "conf/app.ini",
	content: "k=v",
	mountPath: "/app.ini",
};

describe("member rights on applications", () => {
	test("a member works inside the applications they were given", async () => {
		const { t, mallory, applicationId, otherId, environmentId } = await seed();
		await grantMember(t, "org1", "mallory", { services: [applicationId] });

		expect(
			await mallory.query(api.applications.applications.get, { applicationId }),
		).toMatchObject({ name: "Web" });
		await mallory.mutation(api.applications.deploy.deploy, { applicationId });
		await markDeployed(t, "applications", applicationId);
		await mallory.mutation(api.applications.deploy.stop, { applicationId });
		await mallory.mutation(api.applications.deploy.cancelDeployments, {
			applicationId,
		});
		await mallory.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "A=1",
		});
		expect(
			await mallory.query(api.applications.applications.getEnvironment, {
				applicationId,
			}),
		).toMatchObject({ env: "A=1" });
		const mountId = await mallory.mutation(api.applications.mounts.create, {
			applicationId,
			mount: fileMount,
		});
		await mallory.mutation(api.applications.mounts.remove, { mountId });
		expect(
			await mallory.query(api.applications.deploy.listDeployments, {
				applicationId,
			}),
		).toHaveLength(1);

		const listed = await mallory.query(
			api.applications.applications.listByEnvironment,
			{ environmentId },
		);
		expect(listed.map((app) => app._id)).toEqual([applicationId]);

		await expect(
			mallory.query(api.applications.applications.get, {
				applicationId: otherId,
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			mallory.mutation(api.applications.deploy.deploy, {
				applicationId: otherId,
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			mallory.query(api.applications.mounts.list, { applicationId: otherId }),
		).rejects.toThrow(/access to this service/);
	});

	test("service settings, deletion and creation need the member's grants", async () => {
		const { t, mallory, applicationId, environmentId } = await seed();
		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		const rename = () =>
			mallory.mutation(api.applications.applications.update, {
				applicationId,
				name: "Renamed",
			});
		await expect(rename()).rejects.toThrow(/service\.create/);
		await expect(
			mallory.mutation(api.applications.applications.remove, { applicationId }),
		).rejects.toThrow(/service\.delete/);
		await expect(
			mallory.mutation(api.applications.applications.create, {
				environmentId,
				name: "Mine",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			mallory.mutation(api.applications.traefikConfig.read, { applicationId }),
		).rejects.toThrow(/traefikFiles\.read/);

		await grantMember(t, "org1", "mallory", {
			flags: { canCreateServices: true, canAccessToTraefikFiles: true },
		});
		await rename();
		await mallory.mutation(api.applications.traefikConfig.read, {
			applicationId,
		});
		await expect(
			mallory.mutation(api.applications.traefikConfig.write, {
				applicationId,
				content: "x",
			}),
		).rejects.toThrow(/traefikFiles\.write/);
		// Creating needs the project as well.
		await expect(
			mallory.mutation(api.applications.applications.create, {
				environmentId,
				name: "Mine",
			}),
		).rejects.toThrow(/access to this project/);
	});

	test("what a member creates becomes theirs", async () => {
		const { t, mallory, projectId, environmentId, serverId } = await seed();
		await grantMember(t, "org1", "mallory", {
			projects: [projectId],
			environments: [environmentId],
			flags: { canCreateServices: true, canDeleteServices: true },
		});
		const mine = await mallory.mutation(api.applications.applications.create, {
			environmentId,
			name: "Mine",
			serverId,
		});
		expect(
			await mallory.query(api.applications.applications.get, {
				applicationId: mine,
			}),
		).toMatchObject({ name: "Mine" });
		await mallory.mutation(api.applications.applications.remove, {
			applicationId: mine,
		});
	});

	test("owners and admins are unaffected; other organizations are refused", async () => {
		const { t, alice, applicationId, environmentId } = await seed();
		const ada = asUser(t, "ada");
		for (const user of [alice, ada]) {
			await user.mutation(api.applications.deploy.deploy, { applicationId });
			await user.mutation(api.applications.applications.update, {
				applicationId,
				name: "Web",
			});
			expect(
				await user.query(api.applications.applications.listByEnvironment, {
					environmentId,
				}),
			).toHaveLength(2);
		}
		const eve = asUser(t, "eve");
		await expect(
			eve.mutation(api.applications.deploy.deploy, { applicationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			eve.query(api.applications.mounts.list, { applicationId }),
		).rejects.toThrow(/Not a member/);
	});
});
