import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import { readSecret } from "../lib/secrets";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const COMPOSE_FILE = "services:\n  web:\n    image: nginx:alpine\n";
const SECRET_ENV = "API_KEY=super-secret-value";
const DB_PASSWORD = "Sup3rS3cretDbPass";

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
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "web" },
	);
	await alice.action(api.applications.applications.saveDockerSource, {
		applicationId,
		image: "nginx:alpine",
		username: "bot",
		password: "registry-password",
	});
	await alice.action(api.applications.applications.saveEnvironment, {
		applicationId,
		env: SECRET_ENV,
	});
	await alice.mutation(api.applications.mounts.create, {
		applicationId,
		mount: {
			type: "file",
			filePath: "config.json",
			content: '{"token":"file-secret"}',
			mountPath: "/app/config.json",
		},
	});
	await alice.mutation(api.applications.mounts.create, {
		applicationId,
		mount: { type: "volume", volumeName: "web-data", mountPath: "/data" },
	});
	await alice.mutation(api.infra.domains.create, {
		owner: { kind: "application", id: applicationId },
		host: "shop.example.com",
		https: true,
		certificateType: "letsencrypt",
		port: 8080,
	});
	await t.run(async (ctx) => {
		await ctx.db.insert("basicAuthUsers", {
			organizationId: "org1",
			owner: { kind: "application", id: applicationId },
			username: "admin",
			passwordHash: "$apr1$abcdefgh$0123456789abcdefghijkl",
		});
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		composeFile: COMPOSE_FILE,
	});
	await alice.action(api.compose.crud.setEnv, {
		composeId,
		env: "COMPOSE_SECRET=abc123",
	});
	const databaseId = await alice.action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "db",
		databasePassword: DB_PASSWORD,
	});
	return {
		t,
		alice,
		projectId,
		environmentId,
		applicationId,
		composeId,
		databaseId,
	};
};

const exportAll = async (
	user: ReturnType<typeof asUser>,
	projectId: Id<"projects">,
	environmentId: Id<"environments">,
	includeSecrets: boolean,
) => {
	const args = { projectId, environmentIds: [environmentId], includeSecrets };
	return {
		applications: await user.query(
			internal.applications.projectExport.exportRows,
			args,
		),
		compose: await user.query(internal.compose.projectExport.exportRows, args),
		databases: await user.query(
			internal.databases.projectExport.exportRows,
			args,
		),
	};
};

const sealRows = async <Row extends { secrets?: Record<string, string> }>(
	rows: Row[],
) =>
	await Promise.all(
		rows.map(async (row) => {
			const { secrets, ...rest } = row;
			const sealedSecrets: Record<string, { iv: string; ciphertext: string }> =
				{};
			for (const [key, value] of Object.entries(secrets ?? {})) {
				sealedSecrets[key] = await encryptSecret(value);
			}
			return { ...rest, sealedSecrets };
		}),
	);

const allDocsText = async (t: TestConvex) =>
	await t.run(async (ctx) =>
		JSON.stringify([
			await ctx.db.query("applications").collect(),
			await ctx.db.query("compose").collect(),
			await ctx.db.query("databases").collect(),
			await ctx.db.query("mounts").collect(),
			await ctx.db.query("secrets").collect(),
		]),
	);

describe("project export sections", () => {
	test("only admins of the project's organization can export", async () => {
		const { t, projectId, environmentId } = await seed();
		await expect(
			exportAll(asUser(t, "bob"), projectId, environmentId, false),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			exportAll(asUser(t, "eve"), projectId, environmentId, false),
		).rejects.toThrow(/Not a member/);
	});

	test("exports without secrets carry no plaintext secrets", async () => {
		const { alice, projectId, environmentId } = await seed();
		const sections = await exportAll(alice, projectId, environmentId, false);
		const text = JSON.stringify(sections);
		expect(sections.applications).toHaveLength(1);
		expect(sections.compose).toHaveLength(1);
		expect(sections.databases).toHaveLength(1);
		for (const secret of [
			"super-secret-value",
			"registry-password",
			"file-secret",
			"$apr1$",
			"abc123",
			DB_PASSWORD,
		]) {
			expect(text).not.toContain(secret);
		}
		const [app] = sections.applications;
		expect(app?.mounts).toEqual([
			{ type: "volume", volumeName: "web-data", mountPath: "/data" },
		]);
		expect(app?.warnings.join("\n")).toMatch(/file mount/);
		expect(app?.routing.domains[0]?.host).toBe("shop.example.com");
	});

	test("encrypted exports include secrets", async () => {
		const { alice, projectId, environmentId } = await seed();
		const sections = await exportAll(alice, projectId, environmentId, true);
		expect(sections.applications[0]?.secrets).toMatchObject({
			env: SECRET_ENV,
			dockerPassword: "registry-password",
		});
		expect(sections.applications[0]?.routing.basicAuth).toHaveLength(1);
		expect(sections.compose[0]?.secrets).toEqual({
			env: "COMPOSE_SECRET=abc123",
		});
		expect(sections.databases[0]?.secrets?.password).toBe(DB_PASSWORD);
	});
});

describe("project import sections", () => {
	test("round trip recreates services with encrypted secrets", async () => {
		const { t, alice, projectId, environmentId } = await seed();
		const sections = await exportAll(alice, projectId, environmentId, true);
		const { projectId: importedId, warnings } = await alice.mutation(
			internal.platform.projectTransfer.applyImport,
			{
				organizationId: "org1",
				payload: {
					project: { name: "Shop" },
					environments: [
						{ id: environmentId, name: "production", isDefault: true },
					],
					tags: [],
					sections: {
						applications: await sealRows(sections.applications),
						compose: await sealRows(sections.compose),
						databases: await sealRows(sections.databases),
					},
					warnings: [],
				},
			},
		);
		// Same instance, same panel host: the domain is already taken.
		expect(warnings.join("\n")).toMatch(
			/shop\.example\.com is already used on this server/,
		);
		const imported = await t.run(async (ctx) => {
			const environments = await ctx.db
				.query("environments")
				.withIndex("by_projectId", (q) => q.eq("projectId", importedId))
				.collect();
			const environment = environments[0];
			if (!environment) throw new Error("no environment");
			const byEnv = { environmentId: environment._id };
			const app = await ctx.db
				.query("applications")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", byEnv.environmentId),
				)
				.unique();
			const compose = await ctx.db
				.query("compose")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", byEnv.environmentId),
				)
				.unique();
			const database = await ctx.db
				.query("databases")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", byEnv.environmentId),
				)
				.unique();
			if (!app || !compose || !database) throw new Error("missing service");
			return {
				app,
				compose,
				database,
				appEnv: await readSecret(ctx, "application.env", app._id),
				dockerPassword: await readSecret(
					ctx,
					"application.dockerPassword",
					app._id,
				),
				composeEnv: await readSecret(ctx, "compose.env", compose._id),
				dbPassword: await readSecret(ctx, "databases.password", database._id),
				mounts: await ctx.db.query("mounts").collect(),
				routingOwner: await ctx.db
					.query("routingOwners")
					.withIndex("by_owner", (q) =>
						q.eq("owner.kind", "application").eq("owner.id", app._id),
					)
					.unique(),
				users: await ctx.db
					.query("basicAuthUsers")
					.withIndex("by_owner_and_username", (q) =>
						q.eq("owner.kind", "application").eq("owner.id", app._id),
					)
					.collect(),
			};
		});
		expect(imported.app.organizationId).toBe("org1");
		expect(imported.app.serverId).toBeUndefined();
		expect(imported.app.source).toEqual({
			type: "docker",
			image: "nginx:alpine",
			username: "bot",
		});
		expect(imported.app.appName).toMatch(/^app-.*-[a-z0-9]{6}$/);
		expect(imported.appEnv).toBe(SECRET_ENV);
		expect(imported.dockerPassword).toBe("registry-password");
		expect(imported.composeEnv).toBe("COMPOSE_SECRET=abc123");
		expect(imported.dbPassword).toBe(DB_PASSWORD);
		expect(imported.routingOwner?.appName).toBe(imported.app.appName);
		expect(imported.users.map((u) => u.username)).toEqual(["admin"]);
		const dbVolume = imported.mounts.find(
			(m) => m.owner.id === imported.database._id && m.type === "volume",
		);
		expect(dbVolume).toMatchObject({
			volumeName: `${imported.database.appName}-data`,
		});
		const fileMount = imported.mounts.find(
			(m) => m.owner.id === imported.app._id && m.type === "file",
		);
		expect(fileMount).toMatchObject({ content: '{"token":"file-secret"}' });
		const text = await allDocsText(t);
		for (const secret of [
			"super-secret-value",
			"registry-password",
			"abc123",
			DB_PASSWORD,
		]) {
			expect(text).not.toContain(secret);
		}
	});

	test("plaintext secrets and unknown secret kinds are rejected or ignored", async () => {
		const { t, alice, projectId, environmentId } = await seed();
		const { applications } = await exportAll(
			alice,
			projectId,
			environmentId,
			true,
		);
		const base = {
			organizationId: "org1",
			projectId,
			environmentIdMap: { [environmentId]: environmentId },
		};
		await expect(
			alice.mutation(internal.applications.projectExport.importRows, {
				...base,
				rows: applications,
			}),
		).rejects.toThrow();
		const [row] = await sealRows(applications);
		if (!row) throw new Error("no row");
		const forged = {
			...row,
			sealedSecrets: {
				env: await encryptSecret("A=1"),
				sshPrivateKey: await encryptSecret("forged key"),
			},
		};
		await alice.mutation(internal.applications.projectExport.importRows, {
			...base,
			rows: [forged] as never,
		});
		const kinds = await t.run(async (ctx) =>
			(await ctx.db.query("secrets").collect()).map((s) => s.kind),
		);
		expect(kinds).not.toContain("sshPrivateKey");
		expect(
			kinds.filter((k) => k.startsWith("application.sshPrivateKey")),
		).toEqual([]);
	});

	test("import requires admin of the target organization", async () => {
		const { t, alice, projectId, environmentId } = await seed();
		const { databases } = await exportAll(
			alice,
			projectId,
			environmentId,
			false,
		);
		await expect(
			asUser(t, "bob").mutation(internal.databases.projectExport.importRows, {
				organizationId: "org1",
				projectId,
				environmentIdMap: { [environmentId]: environmentId },
				rows: await sealRows(databases),
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "eve").mutation(internal.databases.projectExport.importRows, {
				organizationId: "org2",
				projectId,
				environmentIdMap: { [environmentId]: environmentId },
				rows: await sealRows(databases),
			}),
		).rejects.toThrow(/Project not found/);
	});

	test("provider git sources are dropped with a warning; plain git URLs are kept", async () => {
		const { alice, projectId, environmentId } = await seed();
		const { applications } = await exportAll(
			alice,
			projectId,
			environmentId,
			false,
		);
		const [row] = applications;
		if (!row) throw new Error("no row");
		const git = {
			branch: "main",
			buildPath: "/",
			submodules: false,
		};
		const { warnings } = await alice.mutation(
			internal.applications.projectExport.importRows,
			{
				organizationId: "org1",
				projectId,
				environmentIdMap: { [environmentId]: environmentId },
				rows: [
					{
						...row,
						routing: { domains: [], redirects: [], ports: [] },
						source: {
							type: "git",
							git: {
								type: "github",
								owner: "acme",
								repository: "shop",
								...git,
							},
						},
					},
					{
						...row,
						routing: { domains: [], redirects: [], ports: [] },
						source: {
							type: "git",
							git: {
								type: "git",
								url: "https://example.com/acme/shop.git",
								...git,
							},
						},
					},
				],
			},
		);
		expect(warnings.join("\n")).toMatch(/github repository acme\/shop/);
		const apps = await alice.query(
			api.applications.applications.listByEnvironment,
			{ environmentId },
		);
		expect(apps.map((a) => a.sourceType).sort()).toEqual([
			"docker",
			"git",
			null,
		] as never);
	});
});

describe("project export/import actions", () => {
	test("passphrase bundles round trip secrets; plain bundles get fresh database passwords", async () => {
		const { t, alice, projectId } = await seed();
		for (const passphrase of ["correct horse battery", undefined]) {
			const { exportId } = await alice.action(
				api.platform.projectTransferNode.exportProject,
				{ projectId, passphrase },
			);
			const bundle = await t.run(async (ctx) => {
				const row = await ctx.db.get("projectExports", exportId);
				const blob = row ? await ctx.storage.get(row.storageId) : null;
				return blob ? await blob.text() : "";
			});
			expect(bundle).not.toContain("super-secret-value");
			expect(bundle).not.toContain(DB_PASSWORD);
			await alice.mutation(
				api.platform.projectTransfer.generateImportUploadUrl,
				{ organizationId: "org1" },
			);
			const storageId = await t.run(
				async (ctx) =>
					await ctx.storage.store(
						new Blob([bundle], { type: "application/json" }),
					),
			);
			const { projectId: importedId, warnings } = await alice.action(
				api.platform.projectTransferNode.importProject,
				{ organizationId: "org1", storageId, passphrase, name: "Copy" },
			);
			const database = await t.run(async (ctx) => {
				const environment = await ctx.db
					.query("environments")
					.withIndex("by_projectId", (q) => q.eq("projectId", importedId))
					.first();
				const row = environment
					? await ctx.db
							.query("databases")
							.withIndex("by_environmentId", (q) =>
								q.eq("environmentId", environment._id),
							)
							.unique()
					: null;
				return row
					? await readSecret(ctx, "databases.password", row._id)
					: null;
			});
			if (passphrase) {
				expect(database).toBe(DB_PASSWORD);
			} else {
				expect(database).toMatch(/^[a-zA-Z0-9]{20}$/);
				expect(warnings.join("\n")).toMatch(/new random passwords/);
				expect(warnings.join("\n")).toMatch(/only included in passphrase/);
			}
		}
		expect(await allDocsText(t)).not.toContain("super-secret-value");
	});
});
