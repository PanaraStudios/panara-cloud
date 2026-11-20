import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

// org1 is the root organization; alice (its owner) is the instance admin.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const serverId = await t.run(async (ctx) =>
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
	const panelApp = await alice.mutation(api.applications.applications.create, {
		environmentId,
		name: "Panel side",
	});
	const serverApp = await alice.mutation(api.applications.applications.create, {
		environmentId,
		name: "Edge side",
		serverId,
	});
	await grantMember(t, "org1", "mallory", {
		services: [panelApp, serverApp],
		flags: { canCreateServices: true },
	});
	return { t, alice, mallory: asUser(t, "mallory"), panelApp, serverApp };
};

const ROUTER = [
	{ key: "traefik.enable", value: "true" },
	{ key: "traefik.http.routers.x.rule", value: "Host(`panel.test`)" },
];

describe("swarm settings members may set", () => {
	test("members cannot add traefik.* or panara-cloud.* labels", async () => {
		const { mallory, panelApp } = await seed();
		await expect(
			mallory.mutation(api.applications.settings.updateServiceSettings, {
				applicationId: panelApp,
				labelsSwarm: ROUTER,
			}),
		).rejects.toThrow(/reserved/);
		await expect(
			mallory.mutation(api.applications.applications.update, {
				applicationId: panelApp,
				labelsSwarm: [{ key: " Traefik.http.routers.y.rule", value: "x" }],
			}),
		).rejects.toThrow(/reserved/);
		await expect(
			mallory.mutation(api.applications.settings.updateServiceSettings, {
				applicationId: panelApp,
				labelsSwarm: [{ key: "panara-cloud.service", value: "other" }],
			}),
		).rejects.toThrow(/reserved/);
		await mallory.mutation(api.applications.settings.updateServiceSettings, {
			applicationId: panelApp,
			labelsSwarm: [{ key: "com.example.team", value: "web" }],
		});
	});

	test("the instance admin keeps router labels", async () => {
		const { alice, panelApp } = await seed();
		await alice.mutation(api.applications.settings.updateServiceSettings, {
			applicationId: panelApp,
			labelsSwarm: ROUTER,
		});
	});

	test("members cannot join the host network or unknown networks", async () => {
		const { mallory, serverApp } = await seed();
		for (const Target of ["host", "bridge", "ingress", "someone-else"]) {
			await expect(
				mallory.mutation(api.applications.settings.updateServiceSettings, {
					applicationId: serverApp,
					networkSwarm: [{ Target }],
				}),
			).rejects.toThrow(/not an overlay network/);
		}
		await mallory.mutation(api.applications.settings.updateServiceSettings, {
			applicationId: serverApp,
			networkSwarm: [{ Target: "panara-cloud-network" }],
		});
	});

	test("reserved host ports cannot be published, even by the admin", async () => {
		const { alice, mallory, panelApp, serverApp } = await seed();
		for (const [who, applicationId, port] of [
			[mallory, panelApp, 443],
			[mallory, serverApp, 80],
			[mallory, panelApp, 3210],
			[alice, panelApp, 443],
		] as const) {
			await expect(
				who.mutation(api.applications.settings.updateServiceSettings, {
					applicationId,
					endpointSpecSwarm: {
						Ports: [
							{ PublishedPort: port, TargetPort: 80, PublishMode: "ingress" },
						],
					},
				}),
			).rejects.toThrow(/managed by Panara Cloud/);
			await expect(
				who.mutation(api.infra.ports.create, {
					owner: { kind: "application", id: applicationId },
					publishedPort: port,
					targetPort: 80,
					protocol: "tcp",
					publishMode: "ingress",
				}),
			).rejects.toThrow(/managed by Panara Cloud/);
		}
		// Panel ports are only reserved on the Panara Cloud server.
		await mallory.mutation(api.infra.ports.create, {
			owner: { kind: "application", id: serverApp },
			publishedPort: 3000,
			targetPort: 3000,
			protocol: "tcp",
			publishMode: "ingress",
		});
	});
});
