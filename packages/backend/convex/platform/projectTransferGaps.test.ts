import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readSecret } from "../lib/secrets";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";
import {
	LEGACY_EXPORT_FORMAT,
	LEGACY_EXPORT_FORMAT_VERSION,
} from "./lib/legacyExport";

const PASSPHRASE = "correct horse battery";

const addServer = (t: TestConvex, organizationId: string, ip: string) =>
	t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: `key-${ip}`,
			publicKey: "ssh-ed25519 AAAA",
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: `server-${ip}`,
			ipAddress: ip,
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		});
	});

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	return { t, alice, projectId, environmentId };
};

const servicesOf = (
	t: TestConvex,
	environmentId: Id<"environments">,
): Promise<
	{ type: string; name: string; id: string; serverId: string | null }[]
> => asUser(t, "alice").query(api.environments.services, { environmentId });

// Uploads a bundle the way the import dialog does: an upload URL first.
const store = async (t: TestConvex, content: string, userId = "alice") => {
	await asUser(t, userId).mutation(
		api.platform.projectTransfer.generateImportUploadUrl,
		{ organizationId: "org1" },
	);
	return await t.run((ctx) =>
		ctx.storage.store(new Blob([content], { type: "application/json" })),
	);
};

// Encrypts a payload the way legacy project exports are encrypted.
const legacyEnvelope = (payload: unknown, passphrase: string) => {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = scryptSync(passphrase, salt, 32, {
		N: 32768,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024,
	});
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(
		Buffer.from(`${LEGACY_EXPORT_FORMAT}:${LEGACY_EXPORT_FORMAT_VERSION}`),
	);
	const data = Buffer.concat([
		cipher.update(gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))),
		cipher.final(),
	]);
	return JSON.stringify({
		format: LEGACY_EXPORT_FORMAT,
		formatVersion: LEGACY_EXPORT_FORMAT_VERSION,
		exportedAt: "2026-01-02T03:04:05.000Z",
		projectName: "Legacy",
		kdf: { salt: salt.toString("base64") },
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	});
};

const legacyPayload = {
	project: { projectId: "p1", name: "Legacy", env: "SHARED=1" },
	tags: [{ name: "imported", color: null }],
	environments: [
		{
			environmentId: "e1",
			name: "production",
			isDefault: true,
			env: "STAGE=prod",
		},
		{ environmentId: "e2", name: "staging", isDefault: false },
	],
	services: [
		{
			kind: "application",
			environmentId: "e1",
			applicationId: "a1",
			name: "api",
			appName: "api-abc123",
			sourceType: "docker",
			dockerImage: "nginx:alpine",
			env: "TOKEN=xyz",
			buildType: "dockerfile",
			dockerfile: "Dockerfile",
			replicas: 2,
			labelsSwarm: { "com.example": "yes" },
			healthCheckSwarm: { Test: ["CMD", "true"], Interval: 1000, Bogus: 1 },
			domains: [
				{
					host: "legacy.example.com",
					https: true,
					port: 80,
					path: "/",
					certificateType: "letsencrypt",
					forwardAuthEnabled: false,
					enabled: true,
				},
			],
			mounts: [{ type: "volume", volumeName: "api-data", mountPath: "/data" }],
			redirects: [],
			security: [{ username: "admin", password: "s3cret" }],
			ports: [{ publishedPort: 8443, targetPort: 443, protocol: "tcp" }],
		},
		{
			kind: "compose",
			environmentId: "e2",
			composeId: "c1",
			name: "stack",
			appName: "stack-def456",
			sourceType: "raw",
			composeType: "docker-compose",
			composeFile: "services:\n  web:\n    image: nginx\n",
			env: "COMPOSE=1",
			domains: [],
			mounts: [],
		},
		{
			kind: "postgres",
			environmentId: "e1",
			postgresId: "d1",
			name: "db",
			appName: "db-ghi789",
			dockerImage: "postgres:16",
			databaseName: "shop",
			databaseUser: "shop",
			databasePassword: "dbpass-from-legacy",
			replicas: 1,
			mounts: [],
		},
	],
	warnings: ["Backups are not transferred."],
};

describe("duplicate keeps organization links", () => {
	test("copies keep server, registry, networks and git provider", async () => {
		const { t, alice, environmentId } = await seed();
		const serverId = await addServer(t, "org1", "10.0.0.1");
		const { registryId, networkId, gitProviderId } = await t.run(
			async (ctx) => ({
				registryId: await ctx.db.insert("registries", {
					organizationId: "org1",
					registryName: "ghcr",
					username: "bot",
					registryUrl: "ghcr.io",
					registryType: "cloud",
				}),
				networkId: await ctx.db.insert("networks", {
					organizationId: "org1",
					serverId,
					name: "backend",
					driver: "overlay",
					internal: false,
					attachable: true,
					enableIPv4: true,
					enableIPv6: false,
					status: "created",
				}),
				gitProviderId: await ctx.db.insert("gitProviders", {
					organizationId: "org1",
					userId: "alice",
					name: "GitHub",
					providerType: "github",
					sharedWithOrganization: true,
					config: { type: "github", githubUrl: "https://github.com" },
					connected: true,
				}),
			}),
		);
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "api", serverId },
		);
		await t.run((ctx) =>
			ctx.db.patch("applications", applicationId, {
				registryId,
				networkIds: [networkId],
				gitProviderId,
				source: {
					type: "git",
					git: {
						type: "github",
						gitProviderId,
						owner: "acme",
						repository: "api",
						branch: "main",
						buildPath: "/",
						submodules: false,
					},
				},
			}),
		);
		const databaseId = await alice.action(api.databases.databases.create, {
			environmentId,
			engine: "redis",
			name: "cache",
			serverId,
		});
		const result = await alice.action(
			api.platform.projectTransferNode.duplicate,
			{
				sourceEnvironmentId: environmentId,
				name: "Shop 2",
				includeServices: true,
				selectedServices: [
					{ id: applicationId, type: "application" },
					{ id: databaseId, type: "redis" },
				],
				duplicateInSameProject: false,
			},
		);
		expect(result.warnings).toEqual([]);
		const copies = await t.run(async (ctx) => ({
			app: await ctx.db
				.query("applications")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", result.environmentId),
				)
				.unique(),
			db: await ctx.db
				.query("databases")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", result.environmentId),
				)
				.unique(),
		}));
		expect(copies.app).toMatchObject({
			serverId,
			registryId,
			networkIds: [networkId],
			gitProviderId,
			source: { type: "git", git: { type: "github", gitProviderId } },
		});
		expect(copies.db?.serverId).toBe(serverId);
	});

	test("an import never takes links from another organization", async () => {
		const { t, alice, projectId, environmentId } = await seed();
		const foreignServer = await addServer(t, "org2", "10.0.0.9");
		const own = await addServer(t, "org1", "10.0.0.8");
		const importRows = (serverId?: Id<"servers">) =>
			alice.mutation(internal.compose.projectExport.importRows, {
				serverId,
				organizationId: "org1",
				projectId,
				environmentIdMap: { src: environmentId },
				rows: [
					{
						environmentId: "src",
						name: "stack",
						appName: "stack-aaaaaa",
						composeType: "docker-compose",
						sourceType: "raw",
						composePath: "./docker-compose.yml",
						composeFile: "services: {}\n",
						command: "",
						createEnvFile: true,
						randomize: false,
						suffix: "",
						isolatedDeployment: false,
						isolatedDeploymentsVolume: false,
						pullImages: false,
						autoDeploy: true,
						triggerType: "push",
						mounts: [],
						routing: { domains: [], redirects: [], ports: [] },
						links: { serverId: foreignServer },
						warnings: [],
					},
				],
			});
		await expect(importRows()).rejects.toThrow(
			/"stack": its server is not available; select a server/,
		);
		const result = await importRows(own);
		expect(result.warnings).toEqual([
			'"stack": its server is not available; it was placed on the selected server.',
		]);
		const [compose] = await servicesOf(t, environmentId);
		expect(compose?.serverId).toBe(own);
	});
});

describe("subset export", () => {
	test("exports only the chosen environments and services", async () => {
		const { t, alice, projectId, environmentId } = await seed();
		const staging = await alice.mutation(api.environments.create, {
			projectId,
			name: "staging",
		});
		const keep = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "keep",
			composeFile: "services: {}\n",
		});
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "skip",
			composeFile: "services: {}\n",
		});
		await alice.action(api.projects.setEnv, { projectId, env: "P=1" });
		const { exportId } = await alice.action(
			api.platform.projectTransferNode.exportProject,
			{
				projectId,
				passphrase: PASSPHRASE,
				environmentIds: [environmentId],
				serviceIds: [keep],
			},
		);
		const row = await t.run((ctx) => ctx.db.get("projectExports", exportId));
		const exported = await t.run(async (ctx) =>
			(await ctx.storage.get(row?.storageId as Id<"_storage">))?.text(),
		);
		await expect(
			alice.action(api.platform.projectTransferNode.previewImport, {
				organizationId: "org1",
				storageId: row?.storageId as Id<"_storage">,
				passphrase: PASSPHRASE,
			}),
		).rejects.toThrow(/Upload not found/);
		const storageId = await store(t, exported ?? "");
		const preview = await alice.action(
			api.platform.projectTransferNode.previewImport,
			{ organizationId: "org1", storageId, passphrase: PASSPHRASE },
		);
		expect(preview.environments).toEqual([
			{
				name: "production",
				services: [{ name: "keep", type: "compose" }],
			},
		]);
		const { projectId: imported } = await alice.action(
			api.platform.projectTransferNode.importProject,
			{ organizationId: "org1", storageId, passphrase: PASSPHRASE },
		);
		expect(await t.run((ctx) => readSecret(ctx, "project.env", imported))).toBe(
			"P=1",
		);
		expect(staging).toBeDefined();
	});

	test("rejects services of other projects and non-admins", async () => {
		const { t, alice, projectId } = await seed();
		const other = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Other",
		});
		const foreign = await alice.mutation(api.compose.crud.create, {
			environmentId: other.environmentId,
			name: "x",
			composeFile: "services: {}\n",
		});
		await expect(
			alice.action(api.platform.projectTransferNode.exportProject, {
				projectId,
				serviceIds: [foreign],
			}),
		).rejects.toThrow(/not found in this project/);
		await expect(
			asUser(t, "bob").action(api.platform.projectTransferNode.exportProject, {
				projectId,
			}),
		).rejects.toThrow(/admin role/);
	});
});

describe("import server choice and legacy exports", () => {
	test("imports a legacy export onto the chosen server", async () => {
		const { t, alice } = await seed();
		const serverId = await addServer(t, "org1", "10.0.0.2");
		const storageId = await store(t, legacyEnvelope(legacyPayload, PASSPHRASE));
		const preview = await alice.action(
			api.platform.projectTransferNode.previewImport,
			{ organizationId: "org1", storageId, passphrase: PASSPHRASE },
		);
		expect(preview).toMatchObject({
			format: "legacy",
			projectName: "Legacy",
			environments: [
				{
					name: "production",
					services: [
						{ name: "api", type: "application" },
						{ name: "db", type: "postgres" },
					],
				},
				{ name: "staging", services: [{ name: "stack", type: "compose" }] },
			],
		});
		const { projectId, warnings } = await alice.action(
			api.platform.projectTransferNode.importProject,
			{ organizationId: "org1", storageId, passphrase: PASSPHRASE, serverId },
		);
		expect(warnings).toContain("Backups are not transferred.");
		const environments = await alice.query(api.environments.list, {
			projectId,
		});
		const production = environments.find((e) => e.name === "production");
		const services = await servicesOf(t, production?._id as Id<"environments">);
		expect(services.map((s) => [s.type, s.name, s.serverId]).sort()).toEqual([
			["application", "api", serverId],
			["postgres", "db", serverId],
		]);
		const app = await t.run((ctx) =>
			ctx.db.get(
				"applications",
				services.find((s) => s.type === "application")
					?.id as Id<"applications">,
			),
		);
		expect(app).toMatchObject({
			replicas: 2,
			source: { type: "docker", image: "nginx:alpine" },
			labelsSwarm: [{ key: "com.example", value: "yes" }],
			healthCheckSwarm: { Test: ["CMD", "true"], Interval: 1000 },
		});
		const db = services.find((s) => s.type === "postgres");
		const stored = await t.run(async (ctx) => ({
			projectEnv: await readSecret(ctx, "project.env", projectId),
			environmentEnv: await readSecret(
				ctx,
				"environment.env",
				production?._id as string,
			),
			appEnv: await readSecret(ctx, "application.env", app?._id as string),
			password: await readSecret(ctx, "databases.password", db?.id as string),
			users: await ctx.db.query("basicAuthUsers").collect(),
			domains: await ctx.db.query("domains").collect(),
		}));
		expect(stored).toMatchObject({
			projectEnv: "SHARED=1",
			environmentEnv: "STAGE=prod",
			appEnv: "TOKEN=xyz",
			password: "dbpass-from-legacy",
		});
		expect(stored.users[0]?.passwordHash).toMatch(/^\$apr1\$/);
		expect(stored.domains[0]).toMatchObject({
			host: "legacy.example.com",
			serverId,
		});
	});

	test("rejects a wrong passphrase and servers of other organizations", async () => {
		const { t, alice } = await seed();
		const storageId = await store(t, legacyEnvelope(legacyPayload, PASSPHRASE));
		await expect(
			alice.action(api.platform.projectTransferNode.previewImport, {
				organizationId: "org1",
				storageId,
				passphrase: "wrong passphrase!",
			}),
		).rejects.toThrow(/wrong passphrase/);
		const foreign = await addServer(t, "org2", "10.0.0.3");
		await expect(
			alice.action(api.platform.projectTransferNode.importProject, {
				organizationId: "org1",
				storageId,
				passphrase: PASSPHRASE,
				serverId: foreign,
			}),
		).rejects.toThrow(/Server not found/);
		await expect(
			asUser(t, "bob").action(api.platform.projectTransferNode.previewImport, {
				organizationId: "org1",
				storageId,
				passphrase: PASSPHRASE,
			}),
		).rejects.toThrow(/admin role/);
	});
});

describe("remote servers only", () => {
	test("instance admins toggle it and it blocks panel-host services", async () => {
		const { t, alice, environmentId } = await seed();
		for (const user of ["bob", "eve"]) {
			await expect(
				asUser(t, user).mutation(
					api.platform.deployTargets.setRemoteServersOnly,
					{
						remoteServersOnly: true,
					},
				),
			).rejects.toThrow(/instance administrator/);
		}
		await alice.mutation(api.platform.deployTargets.setRemoteServersOnly, {
			remoteServersOnly: true,
		});
		expect(
			await asUser(t, "bob").query(
				api.platform.deployTargets.remoteServersOnly,
				{},
			),
		).toBe(true);
		await expect(
			t.query(api.platform.deployTargets.remoteServersOnly, {}),
		).rejects.toThrow(/Not authenticated/);
		await expect(
			alice.mutation(api.applications.applications.create, {
				environmentId,
				name: "local",
			}),
		).rejects.toThrow(/Remote servers only/);
		await expect(
			alice.mutation(api.compose.crud.create, {
				environmentId,
				name: "local",
			}),
		).rejects.toThrow(/Remote servers only/);
		await expect(
			alice.action(api.databases.databases.create, {
				environmentId,
				engine: "redis",
				name: "local",
			}),
		).rejects.toThrow(/Remote servers only/);
		const serverId = await addServer(t, "org1", "10.0.0.4");
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "remote",
			serverId,
		});
		const storageId = await store(t, legacyEnvelope(legacyPayload, PASSPHRASE));
		await expect(
			alice.action(api.platform.projectTransferNode.importProject, {
				organizationId: "org1",
				storageId,
				passphrase: PASSPHRASE,
			}),
		).rejects.toThrow(/Remote servers only/);
	});
});

describe("template base URL", () => {
	test("instance admins set it; it drives logo URLs", async () => {
		const { t, alice } = await seed();
		await t.run((ctx) =>
			ctx.db.insert("templates", {
				templateId: "ghost",
				name: "Ghost",
				description: "",
				version: "1",
				logo: "ghost.png",
				links: { github: "" },
				tags: [],
				searchText: "ghost",
				refreshedAt: 1,
			}),
		);
		await expect(
			asUser(t, "bob").mutation(api.platform.templates.setBaseUrl, {
				baseUrl: "https://templates.example.com",
			}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			alice.mutation(api.platform.templates.setBaseUrl, {
				baseUrl: "ftp://templates.example.com",
			}),
		).rejects.toThrow(/http\(s\) URL/);
		await alice.mutation(api.platform.templates.setBaseUrl, {
			baseUrl: "https://templates.example.com/catalog/",
		});
		expect(
			await alice.query(api.platform.templates.baseUrlSettings, {}),
		).toEqual({
			baseUrl: "https://templates.example.com/catalog",
			custom: "https://templates.example.com/catalog",
			defaultBaseUrl: "https://panarastudios.github.io/panara-cloud-templates",
			canEdit: true,
		});
		expect(
			(await asUser(t, "bob").query(api.platform.templates.baseUrlSettings, {}))
				.canEdit,
		).toBe(false);
		const [ghost] = await alice.query(api.platform.templates.list, {});
		expect(ghost?.logoUrl).toBe(
			"https://templates.example.com/catalog/blueprints/ghost/ghost.png",
		);
		await alice.mutation(api.platform.templates.setBaseUrl, { baseUrl: null });
		expect(
			(await alice.query(api.platform.templates.baseUrlSettings, {})).custom,
		).toBeNull();
	});
});
