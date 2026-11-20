import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";

type Agent = ReturnType<typeof asAgent>;

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	await addMember(t, "org2", "erin", "admin");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const serverId = await t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId: "org1",
			name: "key",
			publicKey: "ssh-ed25519 AAAA",
		});
		await ctx.db.insert("secrets", {
			organizationId: "org1",
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			...(await encryptSecret("PRIVATE KEY")),
		});
		return await ctx.db.insert("servers", {
			organizationId: "org1",
			name: "edge",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		});
	});
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web", serverId },
	);
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, environmentId, serverId, applicationId, agent };
};

const addRegistry = (t: TestConvex, organizationId = "org1") =>
	t.run(async (ctx) => {
		const registryId = await ctx.db.insert("registries", {
			organizationId,
			registryName: "private",
			username: "acme",
			registryUrl: "registry.example.com",
			registryType: "selfHosted",
		});
		await ctx.db.insert("secrets", {
			organizationId,
			kind: "sources.registry.password",
			ownerId: registryId,
			...(await encryptSecret("REGISTRY-PASSWORD")),
		});
		return registryId;
	});

const claim = async (agent: Agent, kind: string) => {
	for (let i = 0; i < 50; i++) {
		const next = await agent.mutation(api.agent.claimNext, {});
		if (!next) break;
		const lease = { jobId: next.jobId, leaseId: next.leaseId };
		if (next.spec.kind === kind) return { lease, spec: next.spec };
		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
	}
	throw new Error(`No ${kind} job queued`);
};

const addRollback = (
	t: TestConvex,
	applicationId: Id<"applications">,
	version: number,
	registryId?: Id<"registries">,
) =>
	t.run((ctx) =>
		ctx.db.insert("applicationRollbacks", {
			organizationId: "org1",
			applicationId,
			version,
			image: registryId
				? `registry.example.com/acme/app:v${version}`
				: `app:v${version}`,
			localTag: `app:v${version}`,
			registryId,
		}),
	);

describe("rollback images in registries", () => {
	test("removing a pushed rollback queues a registry delete with credentials only for the lease holder", async () => {
		const { t, alice, applicationId, agent } = await seed();
		const registryId = await addRegistry(t);
		const pushed = await addRollback(t, applicationId, 1, registryId);
		await addRollback(t, applicationId, 2, registryId);
		const local = await addRollback(t, applicationId, 3);

		await expect(
			asUser(t, "mallory").mutation(api.applications.rollbacks.remove, {
				rollbackId: pushed,
			}),
		).rejects.toThrow(/access to this service/);
		await alice.mutation(api.applications.rollbacks.remove, {
			rollbackId: local,
		});
		await alice.mutation(api.applications.rollbacks.remove, {
			rollbackId: pushed,
		});
		const jobs = await t.run((ctx) =>
			ctx.db
				.query("jobs")
				.collect()
				.then((all) =>
					all.filter((j) => j.spec.kind === "application.rollbackImagesRemove"),
				),
		);
		expect(jobs.map((j) => j.spec)).toEqual([
			{
				kind: "application.rollbackImagesRemove",
				applicationId,
				registryId,
				images: ["registry.example.com/acme/app:v1"],
			},
		]);
		// Job specs never carry the registry password.
		expect(JSON.stringify(jobs)).not.toContain("REGISTRY-PASSWORD");

		const { lease } = await claim(agent, "application.rollbackImagesRemove");
		await expect(
			asUser(t, "alice").query(
				api.applications.rollbackImages.getContext,
				lease,
			),
		).rejects.toThrow();
		await expect(
			agent.query(api.applications.rollbackImages.getContext, {
				...lease,
				leaseId: "wrong",
			}),
		).rejects.toThrow(/Lease lost/);
		expect(
			await agent.query(api.applications.rollbackImages.getContext, lease),
		).toEqual({
			registry: {
				registryUrl: "registry.example.com",
				username: "acme",
				password: "REGISTRY-PASSWORD",
			},
			images: ["registry.example.com/acme/app:v1"],
			kept: ["registry.example.com/acme/app:v2"],
		});
	});

	test("pruning past the retention count queues deletion of pushed images", async () => {
		const { t, alice, applicationId, agent } = await seed();
		const registryId = await addRegistry(t);
		await alice.mutation(api.applications.applications.saveRollbackSettings, {
			applicationId,
			enabled: true,
			keep: 1,
			registryId,
		});
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: {
				type: "git",
				url: "https://github.com/acme/web.git",
				branch: "main",
				buildPath: "/",
				submodules: false,
			},
		});
		const prunes: string[][] = [];
		for (const version of [1, 2]) {
			await alice.mutation(api.applications.deploy.deploy, { applicationId });
			const { lease } = await claim(agent, "application.deploy");
			const { prune } = await agent.action(
				api.applications.agent.recordRollback,
				{
					...lease,
					version,
					image: `registry.example.com/acme/app:v${version}`,
					localTag: `app:v${version}`,
				},
			);
			prunes.push(prune);
			await agent.mutation(api.agent.complete, {
				...lease,
				result: { kind: "none" },
			});
		}
		expect(prunes).toEqual([[], ["app:v1"]]);
		const { spec } = await claim(agent, "application.rollbackImagesRemove");
		expect(spec).toMatchObject({
			registryId,
			images: ["registry.example.com/acme/app:v1"],
		});
	});

	test("a registry of another organization is never returned", async () => {
		const { t, applicationId, agent } = await seed();
		const foreign = await addRegistry(t, "org2");
		await t.run(async (ctx) => {
			const app = await ctx.db.get("applications", applicationId);
			if (!app) throw new Error("missing app");
			await ctx.db.insert("jobs", {
				organizationId: "org1",
				partition: app.serverId ?? "local",
				group: `application:${applicationId}`,
				spec: {
					kind: "application.rollbackImagesRemove",
					applicationId,
					registryId: foreign,
					images: ["registry.example.com/acme/app:v1"],
				},
				status: "queued",
				attempts: 0,
				maxAttempts: 1,
				idempotent: true,
				cancelRequested: false,
			});
		});
		const { lease } = await claim(agent, "application.rollbackImagesRemove");
		await expect(
			agent.query(api.applications.rollbackImages.getContext, lease),
		).rejects.toThrow(/Registry not found/);
	});
});

describe("application Traefik config", () => {
	test("admins read and write the app's dynamic file through infra's file job", async () => {
		const { t, alice, applicationId, serverId } = await seed();
		const app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		const readJob = await alice.mutation(api.applications.traefikConfig.read, {
			applicationId,
		});
		const writeJob = await alice.mutation(
			api.applications.traefikConfig.write,
			{ applicationId, content: "http: {}\n" },
		);
		const [read, write] = await t.run(async (ctx) => [
			await ctx.db.get("jobs", readJob),
			await ctx.db.get("jobs", writeJob),
		]);
		expect(read).toMatchObject({
			partition: serverId,
			spec: {
				kind: "infra.traefikFiles",
				serverId,
				op: "read",
				path: `dynamic/${app?.appName}.yml`,
			},
		});
		expect(write).toMatchObject({
			group: `traefik:${serverId}`,
			spec: { op: "write", path: `dynamic/${app?.appName}.yml` },
		});
		const op = await t.run((ctx) =>
			ctx.db
				.query("infraOps")
				.withIndex("by_jobId", (q) => q.eq("jobId", writeJob))
				.unique(),
		);
		expect(op).toMatchObject({ restricted: true, input: "http: {}\n" });

		await expect(
			asUser(t, "mallory").mutation(api.applications.traefikConfig.read, {
				applicationId,
			}),
		).rejects.toThrow(/traefikFiles\.read/);
		await expect(
			asUser(t, "eve").mutation(api.applications.traefikConfig.write, {
				applicationId,
				content: "x",
			}),
		).rejects.toThrow(/Not a member/);
		// Restricted results are only for admins.
		await expect(
			asUser(t, "mallory").query(api.infra.snapshots.opResult, {
				jobId: readJob,
			}),
		).rejects.toThrow(/admin role/);
	});

	test("writing an app's file on the panel host needs an instance administrator", async () => {
		const t = setup();
		await addMember(t, "root", "olivia", "owner");
		await addMember(t, "org2", "erin", "owner");
		const { environmentId } = await asUser(t, "erin").mutation(
			api.projects.create,
			{ organizationId: "org2", name: "Web" },
		);
		const applicationId = await t.run((ctx) =>
			ctx.db.get("environments", environmentId).then((env) =>
				ctx.db.insert("applications", {
					organizationId: "org2",
					projectId: env?.projectId as Id<"projects">,
					environmentId,
					name: "Web",
					appName: "app-panel-abc123",
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
					refreshToken: "token",
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
				}),
			),
		);
		expect(
			await asUser(t, "erin").mutation(api.applications.traefikConfig.read, {
				applicationId,
			}),
		).toBeTruthy();
		await expect(
			asUser(t, "erin").mutation(api.applications.traefikConfig.write, {
				applicationId,
				content: "x",
			}),
		).rejects.toThrow(/instance administrator/);
	});
});
