import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	addServer,
	asUser,
	grantMember,
	setup,
} from "../test.setup";
import { isProtectedHostPath, isReservedName } from "./hostPolicy";

// org1 holds the oldest membership: it is the root organization and its
// admin alice is the instance administrator.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "carol", "member");
	await addMember(t, "org2", "eve", "owner");
	await addMember(t, "org2", "bob", "member");
	const alice = asUser(t, "alice");
	const eve = asUser(t, "eve");
	const root = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Root",
	});
	const other = await eve.mutation(api.projects.create, {
		organizationId: "org2",
		name: "Other",
	});
	const serverId = await addServer(t, "org2");
	const otherApp = await eve.mutation(api.applications.applications.create, {
		environmentId: other.environmentId,
		name: "web",
		serverId,
	});
	const panelApp = await alice.mutation(api.applications.applications.create, {
		environmentId: root.environmentId,
		name: "web",
	});
	return { t, alice, eve, root, other, serverId, otherApp, panelApp };
};

const bind = (hostPath: string) => ({
	type: "bind" as const,
	hostPath,
	mountPath: "/data",
});

describe("host paths", () => {
	test("system paths, their parents and children are protected", () => {
		for (const path of [
			"/",
			"//",
			"/var",
			"/var/run",
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/etc",
			"/etc/panara-cloud",
			"/etc/panara-cloud-x/y",
			"/root/.ssh",
			"/var/lib/docker/volumes",
			"/./etc",
		]) {
			expect(isProtectedHostPath(path), path).toBe(true);
		}
		for (const path of ["/srv/data", "/opt/app", "/home/app/uploads"]) {
			expect(isProtectedHostPath(path), path).toBe(false);
		}
		expect(() => isProtectedHostPath("/srv/../etc")).toThrow(/'\.\.'/);
		expect(isReservedName("panara-cloud-convex-data")).toBe(true);
		expect(isReservedName("Panara_Cloud")).toBe(true);
		expect(isReservedName("my-panara-cloud")).toBe(false);
	});
});

describe("bind mounts", () => {
	test("org admins bind non-system paths on their own servers only", async () => {
		const { t, eve, otherApp } = await seed();
		await eve.mutation(api.applications.mounts.create, {
			applicationId: otherApp,
			mount: bind("/srv/data"),
		});
		for (const path of ["/", "/var/run/docker.sock", "/etc/panara-cloud"]) {
			await expect(
				eve.mutation(api.applications.mounts.create, {
					applicationId: otherApp,
					mount: { ...bind(path), mountPath: "/other" },
				}),
			).rejects.toThrow(/not allowed: it exposes the host system/);
		}
		await grantMember(t, "org2", "bob", {
			services: [otherApp],
			flags: { canCreateServices: true },
		});
		await expect(
			asUser(t, "bob").mutation(api.applications.mounts.create, {
				applicationId: otherApp,
				mount: { ...bind("/srv/x"), mountPath: "/x" },
			}),
		).rejects.toThrow(/Only organization owners and admins/);
		const [mount] = await eve.query(api.applications.mounts.list, {
			applicationId: otherApp,
		});
		if (!mount) throw new Error("no mount");
		await expect(
			eve.mutation(api.applications.mounts.update, {
				mountId: mount._id,
				mount: bind("/var/lib/docker"),
			}),
		).rejects.toThrow(/not allowed/);
	});

	test("the panel host only takes bind mounts from the instance administrator", async () => {
		const { t, alice, panelApp } = await seed();
		await alice.mutation(api.applications.mounts.create, {
			applicationId: panelApp,
			mount: bind("/var/run/docker.sock"),
		});
		await grantMember(t, "org1", "carol", {
			services: [panelApp],
			flags: { canCreateServices: true },
		});
		await expect(
			asUser(t, "carol").mutation(api.applications.mounts.create, {
				applicationId: panelApp,
				mount: { ...bind("/srv/x"), mountPath: "/x" },
			}),
		).rejects.toThrow(/Only the instance administrator can add bind mounts/);
	});

	test("compose mounts follow the same rules", async () => {
		const { eve, other, serverId } = await seed();
		const composeId = await eve.mutation(api.compose.crud.create, {
			environmentId: other.environmentId,
			name: "stack",
			serverId,
			composeFile: "services:\n  web:\n    image: nginx\n",
		});
		await expect(
			eve.mutation(api.compose.mounts.add, {
				composeId,
				mount: bind("/var/run/docker.sock"),
			}),
		).rejects.toThrow(/not allowed/);
		await eve.mutation(api.compose.mounts.add, {
			composeId,
			mount: bind("/srv/stack"),
		});
	});
});

describe("reserved names", () => {
	test("Panara Cloud volumes and app names can't be claimed", async () => {
		const { alice, eve, other, serverId, otherApp, panelApp } = await seed();
		await expect(
			eve.mutation(api.applications.mounts.create, {
				applicationId: otherApp,
				mount: {
					type: "volume",
					volumeName: "panara-cloud-convex-data",
					mountPath: "/data",
				},
			}),
		).rejects.toThrow(/reserved for Panara Cloud/);
		await eve.mutation(api.applications.mounts.create, {
			applicationId: otherApp,
			mount: { type: "volume", volumeName: "web-data", mountPath: "/data" },
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId: panelApp,
			mount: {
				type: "volume",
				volumeName: "panara-cloud-convex-data",
				mountPath: "/convex",
			},
		});
		await expect(
			eve.mutation(api.compose.crud.create, {
				environmentId: other.environmentId,
				name: "x",
				appName: "panara-cloud-convex",
				serverId,
			}),
		).rejects.toThrow(/already exists|already in use/);
	});
});
