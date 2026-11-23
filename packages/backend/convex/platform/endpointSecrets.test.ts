import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, addServer, asUser, setup } from "../test.setup";

const noEvents = {
	appDeploy: false,
	appBuildError: false,
	databaseBackup: false,
	volumeBackup: false,
	dockerCleanup: false,
	serverThreshold: false,
	panelRestart: false,
	panelBackup: false,
};

// org1 (oldest membership) is the root organization.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org2", "eve", "owner");
	return { t, alice: asUser(t, "alice"), eve: asUser(t, "eve") };
};

describe("stored secrets don't follow a changed endpoint", () => {
	test("GitLab providers", async () => {
		const { eve } = await seed();
		const gitProviderId = await eve.action(api.sources.gitlab.create, {
			organizationId: "org2",
			name: "GitLab",
			gitlabUrl: "https://gitlab.example.com",
			applicationId: "app-id",
			secret: "client-secret",
		});
		await expect(
			eve.action(api.sources.gitlab.update, {
				gitProviderId,
				gitlabUrl: "https://attacker.example",
			}),
		).rejects.toThrow(/client secret again/);
		await eve.action(api.sources.gitlab.update, {
			gitProviderId,
			name: "Renamed",
		});
		await eve.action(api.sources.gitlab.update, {
			gitProviderId,
			gitlabUrl: "https://gitlab2.example.com",
			secret: "new-secret",
		});
	});

	test("notification channels", async () => {
		const { eve } = await seed();
		const notificationId = await eve.action(api.platform.notifications.create, {
			organizationId: "org2",
			name: "gotify",
			channel: {
				type: "gotify",
				serverUrl: "https://gotify.example.com",
				priority: 5,
				decoration: true,
			},
			events: noEvents,
			credentials: { appToken: "token" },
		});
		const moved = {
			type: "gotify" as const,
			serverUrl: "https://attacker.example",
			priority: 5,
			decoration: true,
		};
		await expect(
			eve.action(api.platform.notifications.update, {
				notificationId,
				channel: moved,
			}),
		).rejects.toThrow(/credentials again/);
		await expect(
			eve.action(api.platform.notifications.test, {
				notificationId,
				channel: moved,
			}),
		).rejects.toThrow(/credentials again/);
		await eve.action(api.platform.notifications.update, {
			notificationId,
			channel: {
				...moved,
				serverUrl: "https://gotify.example.com",
				priority: 8,
			},
		});
		await eve.action(api.platform.notifications.update, {
			notificationId,
			channel: moved,
			credentials: { appToken: "new-token" },
		});
	});

	test("telemetry providers", async () => {
		const { eve } = await seed();
		const telemetryProviderId = await eve.action(
			api.platform.telemetryActions.create,
			{
				organizationId: "org2",
				name: "Loki",
				providerType: "loki",
				signals: ["logs"],
				endpoint: "https://loki.example.com",
				apiKey: "loki-token",
				extraConfig: { username: "1", tenantId: "a" },
			},
		);
		await expect(
			eve.action(api.platform.telemetryActions.update, {
				telemetryProviderId,
				endpoint: "https://attacker.example",
			}),
		).rejects.toThrow(/API key and secret again/);
		await eve.action(api.platform.telemetryActions.update, {
			telemetryProviderId,
			endpoint: "https://loki2.example.com",
			apiKey: "loki-token-2",
		});
	});

	test("registries; panel host logins are for the instance administrator", async () => {
		const { t, alice, eve } = await seed();
		const serverId = await addServer(t, "org2");
		const { registryId } = await eve.action(api.sources.registries.create, {
			organizationId: "org2",
			registryName: "GHCR",
			registryUrl: "ghcr.io",
			username: "u",
			password: "p",
			serverId,
		});
		await expect(
			eve.action(api.sources.registries.update, {
				registryId,
				registryUrl: "attacker.example",
				serverId,
			}),
		).rejects.toThrow(/password again/);
		await expect(
			eve.action(api.sources.registries.update, { registryId }),
		).rejects.toThrow(/Select a server/);
		await eve.action(api.sources.registries.update, {
			registryId,
			registryUrl: "registry.example.com",
			password: "p2",
			serverId,
		});
		const jobsBefore = await t.run((ctx) => ctx.db.query("jobs").collect());
		await eve.mutation(api.sources.registries.remove, { registryId });
		const logouts = (await t.run((ctx) => ctx.db.query("jobs").collect()))
			.filter((job) => !jobsBefore.some((j) => j._id === job._id))
			.filter((job) => job.spec.kind === "sources.registryLogout");
		expect(logouts).toEqual([]);

		const { registryId: rootRegistry } = await alice.action(
			api.sources.registries.create,
			{
				organizationId: "org1",
				registryName: "Root",
				registryUrl: "ghcr.io",
				username: "u",
				password: "p",
			},
		);
		await alice.mutation(api.sources.registries.remove, {
			registryId: rootRegistry,
		});
		const rootLogouts = (
			await t.run((ctx) => ctx.db.query("jobs").collect())
		).filter((job) => job.spec.kind === "sources.registryLogout");
		expect(rootLogouts).toHaveLength(1);
	});
});
