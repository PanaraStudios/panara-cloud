import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";
import { permissionsForMember, permissionsForRole } from "./permissions";

describe("permissions", () => {
	test("members get the default member grants; admins everything", () => {
		const member = permissionsForRole("member");
		expect(member.deployment.create).toBe(true);
		expect(member.envVars.write).toBe(true);
		expect(member.volume.create).toBe(true);
		expect(member.domain.create).toBe(true);
		expect(member.project.create).toBe(false);
		expect(member.server.create).toBe(false);
		expect(member.organization.update).toBe(false);
		const admin = permissionsForRole("admin");
		expect(admin.server.create).toBe(true);
		expect(admin.organization.delete).toBe(false);
		expect(permissionsForRole("owner").organization.delete).toBe(true);
	});

	test("the UI reads the caller's permissions; outsiders are refused", async () => {
		const t = setup();
		await addMember(t, "org1", "bob", "member");
		const result = await asUser(t, "bob").query(api.account.permissions, {
			organizationId: "org1",
		});
		expect(result.role).toBe("member");
		expect(result.permissions.deployment.create).toBe(true);
		expect(result.permissions.server.create).toBe(false);
		await expect(
			asUser(t, "eve").query(api.account.permissions, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("per-member grants extend only the member role", () => {
		const grants = {
			accessedProjects: [],
			accessedEnvironments: [],
			accessedServices: [],
			canCreateProjects: true,
			canDeleteProjects: false,
			canCreateServices: true,
			canDeleteServices: false,
			canCreateEnvironments: false,
			canDeleteEnvironments: false,
			canAccessToTraefikFiles: true,
			canAccessToDocker: true,
			canAccessToAPI: false,
			canAccessToSSHKeys: true,
			canAccessToGitProviders: false,
		};
		const member = permissionsForMember("member", grants);
		expect(member.project).toEqual({ create: true, delete: false });
		expect(member.service).toEqual({ create: true, read: true, delete: false });
		expect(member.traefikFiles).toEqual({ read: true, write: false });
		expect(member.docker.read).toBe(true);
		expect(member.sshKeys).toEqual({ read: true, create: true, delete: true });
		expect(member.gitProviders.read).toBe(false);
		expect(member.api.read).toBe(false);
		expect(member.server.read).toBe(false);
		expect(permissionsForMember("admin", null).docker.read).toBe(true);
	});

	test("admins assign grants; the member's permissions follow", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org1", "carol", "admin");
		await addMember(t, "org2", "mallory", "owner");
		const alice = asUser(t, "alice");
		const { projectId, environmentId } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "web",
		});
		const foreign = await asUser(t, "mallory").mutation(api.projects.create, {
			organizationId: "org2",
			name: "Theirs",
		});

		const tree = await alice.query(api.permissions.projects, {
			organizationId: "org1",
		});
		expect(tree).toEqual([
			{
				projectId,
				name: "Shop",
				environments: [
					expect.objectContaining({
						environmentId,
						services: [
							expect.objectContaining({ id: composeId, type: "compose" }),
						],
					}),
				],
			},
		]);
		expect(
			await alice.query(api.permissions.forMember, {
				organizationId: "org1",
				userId: "bob",
			}),
		).toMatchObject({
			role: "member",
			accessedProjects: [],
			canAccessToDocker: false,
		});

		const flags = {
			canCreateProjects: false,
			canDeleteProjects: false,
			canCreateServices: true,
			canDeleteServices: false,
			canCreateEnvironments: false,
			canDeleteEnvironments: false,
			canAccessToTraefikFiles: false,
			canAccessToDocker: true,
			canAccessToAPI: false,
			canAccessToSSHKeys: false,
			canAccessToGitProviders: false,
		};
		await alice.mutation(api.permissions.assign, {
			organizationId: "org1",
			userId: "bob",
			accessedProjects: [projectId, foreign.projectId, "junk"],
			accessedEnvironments: [environmentId, foreign.environmentId],
			accessedServices: [composeId, "junk"],
			...flags,
		});
		expect(
			await alice.query(api.permissions.forMember, {
				organizationId: "org1",
				userId: "bob",
			}),
		).toMatchObject({
			accessedProjects: [projectId],
			accessedEnvironments: [environmentId],
			accessedServices: [composeId],
			canCreateServices: true,
			canAccessToDocker: true,
		});
		const resolved = await asUser(t, "bob").query(api.account.permissions, {
			organizationId: "org1",
		});
		expect(resolved.permissions.docker.read).toBe(true);
		expect(resolved.permissions.service.create).toBe(true);
		expect(resolved.permissions.project.create).toBe(false);

		const assignArgs = {
			organizationId: "org1",
			accessedProjects: [],
			accessedEnvironments: [],
			accessedServices: [],
			...flags,
		};
		await expect(
			asUser(t, "bob").mutation(api.permissions.assign, {
				...assignArgs,
				userId: "bob",
			}),
		).rejects.toThrow(/member.update permission/);
		await expect(
			alice.mutation(api.permissions.assign, {
				...assignArgs,
				userId: "carol",
			}),
		).rejects.toThrow(/already hold every permission/);
		await expect(
			alice.mutation(api.permissions.assign, {
				...assignArgs,
				userId: "alice",
			}),
		).rejects.toThrow(/your own permissions/);
		await expect(
			asUser(t, "mallory").mutation(api.permissions.assign, {
				...assignArgs,
				userId: "bob",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "bob").query(api.permissions.projects, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/member.update permission/);
	});

	test("actions check permissions and service scope through the internal query", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		const { environmentId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const composeId = await asUser(t, "alice").mutation(
			api.compose.crud.create,
			{ environmentId, name: "web" },
		);
		const bob = asUser(t, "bob");
		const check = {
			organizationId: "org1",
			resource: "deployment",
			action: "create",
			serviceId: composeId,
		};
		await expect(bob.query(internal.permissions.check, check)).rejects.toThrow(
			/access to this service/,
		);
		await grantMember(t, "org1", "bob", { services: [composeId] });
		await expect(
			bob.query(internal.permissions.check, check),
		).resolves.toMatchObject({ userId: "bob", role: "member" });
		await expect(
			bob.query(internal.permissions.check, {
				...check,
				resource: "server",
				action: "create",
			}),
		).rejects.toThrow(/server.create permission/);
		await expect(
			bob.query(internal.permissions.check, { ...check, action: "fly" }),
		).rejects.toThrow(/Unknown permission/);
	});
});
