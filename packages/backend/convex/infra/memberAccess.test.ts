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
import { registerRoutingOwner } from "./routing";

const app = { kind: "application" as const, id: "app1" };

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "admin");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const serverId = (await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId: "org1",
			name: "web",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: true,
		}),
	)) as Id<"servers">;
	await t.run((ctx) =>
		registerRoutingOwner(ctx, {
			organizationId: "org1",
			owner: app,
			serverId,
			appName: "app-app1",
		}),
	);
	return { t, serverId };
};

const port = {
	publishedPort: 8080,
	targetPort: 80,
	protocol: "tcp" as const,
	publishMode: "ingress" as const,
};

const redirect = {
	regex: "^https?://www\\.(.*)",
	replacement: "https://$1",
	permanent: true,
};

const grantApp = (t: TestConvex, canCreateServices = false) =>
	grantMember(t, "org1", "mallory", {
		services: [app.id],
		flags: { canCreateServices, canDeleteServices: canCreateServices },
	});

describe("member access to a service's routing", () => {
	test("ports and redirects need the service and service.create", async () => {
		const { t } = await seed();
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.infra.ports.listByOwner, { owner: app }),
		).rejects.toThrow(/access to this service/);

		await grantApp(t);
		expect(
			await mallory.query(api.infra.ports.listByOwner, { owner: app }),
		).toEqual([]);
		await expect(
			mallory.mutation(api.infra.ports.create, { owner: app, ...port }),
		).rejects.toThrow(/service\.create/);
		await expect(
			mallory.mutation(api.infra.redirects.create, {
				owner: app,
				...redirect,
			}),
		).rejects.toThrow(/service\.create/);

		await grantApp(t, true);
		const portId = await mallory.mutation(api.infra.ports.create, {
			owner: app,
			...port,
		});
		await mallory.mutation(api.infra.ports.update, {
			portId,
			...port,
			publishedPort: 8081,
		});
		const redirectId = await mallory.mutation(api.infra.redirects.create, {
			owner: app,
			...redirect,
		});
		await mallory.mutation(api.infra.redirects.remove, { redirectId });
		await mallory.mutation(api.infra.ports.remove, { portId });

		await expect(
			asUser(t, "eve").mutation(api.infra.ports.create, {
				owner: app,
				...port,
			}),
		).rejects.toThrow(/Not a member/);
		await asUser(t, "bob").mutation(api.infra.ports.create, {
			owner: app,
			...port,
		});
	});

	test("basic auth users follow the same rule", async () => {
		const { t } = await seed();
		const mallory = asUser(t, "mallory");
		await grantApp(t);
		await expect(
			mallory.action(api.infra.basicAuth.create, {
				owner: app,
				username: "admin",
				password: "secret",
			}),
		).rejects.toThrow(/service\.create/);
		await grantApp(t, true);
		const userId = await mallory.action(api.infra.basicAuth.create, {
			owner: app,
			username: "admin",
			password: "secret",
		});
		await mallory.mutation(api.infra.basicAuth.remove, { userId });
		expect(
			await mallory.query(api.infra.basicAuth.listByOwner, { owner: app }),
		).toEqual([]);
	});
});

describe("member access to Docker", () => {
	test("container actions and networks need docker.read; swarm and Traefik stay with admins", async () => {
		const { t, serverId } = await seed();
		const mallory = asUser(t, "mallory");
		const restart = {
			serverId,
			action: { type: "containerRestart" as const, containerId: "abc123" },
		};
		await expect(
			mallory.mutation(api.infra.docker.run, restart),
		).rejects.toThrow(/docker\.read/);
		await expect(
			mallory.query(api.infra.snapshots.get, { serverId, kind: "images" }),
		).rejects.toThrow(/docker\.read/);
		await expect(
			mallory.mutation(api.infra.networks.create, {
				organizationId: "org1",
				serverId,
				name: "backend",
				driver: "overlay",
			}),
		).rejects.toThrow(/docker\.read/);

		await grantMember(t, "org1", "mallory", {
			flags: { canAccessToDocker: true },
		});
		await mallory.mutation(api.infra.docker.run, restart);
		await mallory.query(api.infra.snapshots.get, { serverId, kind: "images" });
		await mallory.mutation(api.infra.networks.create, {
			organizationId: "org1",
			serverId,
			name: "backend",
			driver: "overlay",
		});
		await expect(
			mallory.mutation(api.infra.docker.run, {
				serverId,
				action: { type: "traefikRestart" },
			}),
		).rejects.toThrow(/admin role/);
		await expect(
			mallory.mutation(api.infra.docker.run, {
				serverId,
				action: { type: "clusterJoinInfo" },
			}),
		).rejects.toThrow(/admin role/);
		await expect(
			asUser(t, "eve").mutation(api.infra.docker.run, restart),
		).rejects.toThrow(/Not a member/);
	});

	test("Traefik files need traefikFiles; members only read them", async () => {
		const { t, serverId } = await seed();
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.mutation(api.infra.webServer.listTraefikFiles, { serverId }),
		).rejects.toThrow(/traefikFiles\.read/);
		await grantMember(t, "org1", "mallory", {
			flags: { canAccessToTraefikFiles: true },
		});
		const jobId = await mallory.mutation(api.infra.webServer.readTraefikFile, {
			serverId,
			path: "dynamic/app.yml",
		});
		expect(
			await mallory.query(api.infra.snapshots.opResult, { jobId }),
		).toMatchObject({ status: "queued" });
		await expect(
			mallory.mutation(api.infra.webServer.writeTraefikFile, {
				serverId,
				path: "dynamic/app.yml",
				content: "http: {}",
			}),
		).rejects.toThrow(/traefikFiles\.write/);
		await addMember(t, "org1", "mia", "member");
		await expect(
			asUser(t, "mia").query(api.infra.snapshots.opResult, { jobId }),
		).rejects.toThrow(/admin role/);
		await asUser(t, "bob").mutation(api.infra.webServer.writeTraefikFile, {
			serverId,
			path: "dynamic/app.yml",
			content: "http: {}",
		});
	});
});
