import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const addApplication = (
	t: TestConvex,
	environmentId: Id<"environments">,
	name: string,
	status: Doc<"applications">["status"],
) =>
	t.run(async (ctx) => {
		const environment = await ctx.db.get("environments", environmentId);
		return await ctx.db.insert("applications", {
			organizationId: environment?.organizationId ?? "",
			projectId: environment?.projectId as Id<"projects">,
			environmentId,
			name,
			appName: `app-${name}`,
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
			refreshToken: `token-${name}`,
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
			status,
		});
	});

const addDeployment = (
	t: TestConvex,
	organizationId: string,
	target: { kind: string; id: string },
	status: Doc<"jobs">["status"],
	applicationId: Id<"applications">,
) =>
	t.run(async (ctx) => {
		const jobId = await ctx.db.insert("jobs", {
			organizationId,
			partition: "local",
			group: `${target.kind}:${target.id}`,
			spec: {
				kind: "application.deploy",
				applicationId,
			},
			status,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
		});
		await ctx.db.insert("deployments", {
			organizationId,
			jobId,
			target,
			title: "Deploy",
		});
		return jobId;
	});

describe("home overview", () => {
	test("counts services by status and lists service deployments", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "owen", "owner");
		await addMember(t, "org2", "mallory", "owner");
		const { projectId, environmentId } = await asUser(t, "owen").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const web = await addApplication(t, environmentId, "web", "done");
		await addApplication(t, environmentId, "api", "error");
		await addApplication(t, environmentId, "worker", "idle");
		await addDeployment(
			t,
			"org1",
			{ kind: "application", id: web },
			"failed",
			web,
		);
		const succeeded = await addDeployment(
			t,
			"org1",
			{ kind: "application", id: web },
			"succeeded",
			web,
		);
		await addDeployment(
			t,
			"org1",
			{ kind: "databaseBackup", id: "x" },
			"succeeded",
			web,
		);

		const home = await asUser(t, "owen").query(api.platform.overview.home, {
			organizationId: "org1",
		});
		expect(home).toMatchObject({
			projects: 1,
			environments: 1,
			applications: 3,
			compose: 0,
			databases: 0,
			services: 3,
			capped: false,
			status: { running: 1, error: 1, idle: 1 },
		});
		expect(home.deployments.map((d) => [d.jobId, d.status])).toEqual([
			[succeeded, "done"],
			[expect.anything(), "error"],
		]);
		expect(home.deployments[0]).toMatchObject({
			kind: "application",
			serviceId: web,
			name: "web",
			projectId,
			projectName: "Shop",
			environmentId,
			serverName: "Panara Cloud",
		});

		const hidden = await asUser(t, "alice").query(api.platform.overview.home, {
			organizationId: "org1",
		});
		expect(hidden).toMatchObject({
			projects: 0,
			environments: 0,
			services: 0,
			deployments: [],
		});
		await grantMember(t, "org1", "alice", {
			projects: [projectId],
			environments: [environmentId],
			services: [web],
		});
		const scoped = await asUser(t, "alice").query(api.platform.overview.home, {
			organizationId: "org1",
		});
		expect(scoped).toMatchObject({
			projects: 1,
			environments: 1,
			applications: 1,
			services: 1,
			status: { running: 1, error: 0, idle: 0 },
		});
		expect(scoped.deployments.map((d) => d.serviceId)).toEqual([web, web]);

		await expect(
			asUser(t, "mallory").query(api.platform.overview.home, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});
});

describe("home deploy stats", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const deployAt = (
		t: TestConvex,
		at: number,
		organizationId: string,
		kind: string,
	) => {
		vi.setSystemTime(at);
		return t.run(async (ctx) => {
			const jobId = await ctx.db.insert("jobs", {
				organizationId,
				partition: "local",
				group: `${kind}:x`,
				spec: { kind: "noop", message: "x" },
				status: "succeeded",
				attempts: 0,
				maxAttempts: 1,
				idempotent: false,
				cancelRequested: false,
			});
			await ctx.db.insert("deployments", {
				organizationId,
				jobId,
				target: { kind, id: "x" },
				title: "Deploy",
			});
		});
	};

	test("counts application and compose deployments in the last and previous 7 days", async () => {
		vi.useFakeTimers();
		const day = 24 * 60 * 60 * 1000;
		const now = Date.UTC(2026, 10, 18);
		vi.setSystemTime(now - 30 * day);
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org2", "mallory", "owner");
		// convex-test keeps creation times increasing, so insert in time order.
		await deployAt(t, now - 14 * day - 1, "org1", "application");
		await deployAt(t, now - 13 * day, "org1", "compose");
		await deployAt(t, now - 7 * day - 1, "org1", "application");
		await deployAt(t, now - 7 * day + 1, "org1", "application");
		await deployAt(t, now - 2 * day, "org1", "compose");
		await deployAt(t, now - day, "org1", "databaseBackup");
		await deployAt(t, now - day + 1, "org2", "application");
		await deployAt(t, now - 1000, "org1", "application");
		await deployAt(t, now + 1000, "org1", "application");

		const stats = await asUser(t, "alice").query(
			api.platform.overview.deployStats,
			{ organizationId: "org1", now },
		);
		expect(stats).toEqual({
			last: { count: 3, capped: false },
			previous: { count: 2, capped: false },
		});
		await expect(
			asUser(t, "mallory").query(api.platform.overview.deployStats, {
				organizationId: "org1",
				now,
			}),
		).rejects.toThrow(/Not a member/);
	});
});
