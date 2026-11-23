import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { encryptSecret } from "../lib/crypto";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Web" },
	);
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
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web", serverId },
	);
	await grantMember(t, "org1", "mallory", { services: [applicationId] });
	return { t, alice, projectId, environmentId, serverId, applicationId };
};

describe("application settings", () => {
	test("overview joins project, environment and server for members", async () => {
		const { t, projectId, environmentId, applicationId } = await seed();
		const overview = await asUser(t, "mallory").query(
			api.applications.settings.overview,
			{ applicationId },
		);
		expect(overview).toMatchObject({
			environment: { _id: environmentId, name: "production", projectId },
			project: { _id: projectId, name: "Web" },
			server: { name: "edge", ipAddress: "10.0.0.9" },
			hasGitProviderAccess: true,
			hasDockerPassword: false,
		});
		expect(overview?.application).not.toHaveProperty("refreshToken");
	});

	test("overview rejects other organizations", async () => {
		const { t, applicationId } = await seed();
		await expect(
			asUser(t, "eve").query(api.applications.settings.overview, {
				applicationId,
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("overview hides a private provider from other members", async () => {
		const { t, alice, applicationId } = await seed();
		const gitProviderId = await t.run((ctx) =>
			ctx.db.insert("gitProviders", {
				organizationId: "org1",
				userId: "alice",
				name: "GitHub",
				providerType: "github",
				sharedWithOrganization: false,
				config: { type: "github", githubUrl: "https://github.com" },
				connected: true,
			}),
		);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: {
				type: "github",
				gitProviderId,
				owner: "acme",
				repository: "web",
				branch: "main",
				buildPath: "/",
				submodules: false,
			},
			triggerType: "tag",
		});
		const forAlice = await alice.query(api.applications.settings.overview, {
			applicationId,
		});
		expect(forAlice?.hasGitProviderAccess).toBe(true);
		expect(forAlice?.application.triggerType).toBe("tag");
		const forMallory = await asUser(t, "mallory").query(
			api.applications.settings.overview,
			{ applicationId },
		);
		expect(forMallory?.hasGitProviderAccess).toBe(false);
	});

	test("overview reports a stored docker password without revealing it", async () => {
		const { t, alice, applicationId } = await seed();
		await t.run(async (ctx) => {
			await ctx.db.patch("applications", applicationId, {
				source: { type: "docker", image: "nginx:latest", username: "bot" },
			});
			await ctx.db.insert("secrets", {
				organizationId: "org1",
				kind: "application.dockerPassword",
				ownerId: applicationId,
				...(await encryptSecret("hunter2")),
			});
		});
		const overview = await alice.query(api.applications.settings.overview, {
			applicationId,
		});
		expect(overview?.hasDockerPassword).toBe(true);
		expect(JSON.stringify(overview)).not.toContain("hunter2");
	});

	test("updateServiceSettings sets and clears fields; admins only", async () => {
		const { t, alice, applicationId } = await seed();
		await alice.mutation(api.applications.settings.updateServiceSettings, {
			applicationId,
			memoryLimit: "268435456",
			stopGracePeriodSwarm: 10,
		});
		await alice.mutation(api.applications.settings.updateServiceSettings, {
			applicationId,
			clear: ["memoryLimit"],
			cpuLimit: "1000000000",
		});
		const app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		expect(app).toMatchObject({
			stopGracePeriodSwarm: 10,
			cpuLimit: "1000000000",
		});
		expect(app?.memoryLimit).toBeUndefined();
		await expect(
			asUser(t, "mallory").mutation(
				api.applications.settings.updateServiceSettings,
				{ applicationId, cpuLimit: "1" },
			),
		).rejects.toThrow(/service\.create/);
		await grantMember(t, "org1", "mallory", {
			flags: { canCreateServices: true },
		});
		await asUser(t, "mallory").mutation(
			api.applications.settings.updateServiceSettings,
			{ applicationId, cpuLimit: "1" },
		);
		await expect(
			asUser(t, "eve").mutation(
				api.applications.settings.updateServiceSettings,
				{ applicationId, cpuLimit: "1" },
			),
		).rejects.toThrow(/Not a member/);
	});

	test("update stores icons and clean cache", async () => {
		const { t, alice, applicationId } = await seed();
		const icon = "data:image/svg+xml;base64,PHN2Zy8+";
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			icon,
			cleanCache: true,
		});
		let app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		expect(app?.icon).toBe(icon);
		expect(app?.build.cleanCache).toBe(true);
		await expect(
			alice.mutation(api.applications.applications.update, {
				applicationId,
				icon: "javascript:alert(1)",
			}),
		).rejects.toThrow(/image data URL/);
		await expect(
			alice.mutation(api.applications.applications.update, {
				applicationId,
				icon: `data:image/png;base64,${"A".repeat(200 * 1024)}`,
			}),
		).rejects.toThrow(/too large/);
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			icon: null,
		});
		app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		expect(app?.icon).toBeUndefined();
	});
});
