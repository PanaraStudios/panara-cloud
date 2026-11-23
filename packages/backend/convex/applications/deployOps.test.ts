import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, grantMember, SITE_URL, setup } from "../test.setup";

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web" },
	);
	return { t, alice, applicationId };
};

const addDeployment = (
	t: ReturnType<typeof setup>,
	target: { kind: string; id: string },
	status: JobStatus,
	options: { organizationId?: string; kind?: string; group?: string } = {},
) =>
	t.run(async (ctx) => {
		const organizationId = options.organizationId ?? "org1";
		const jobId = await ctx.db.insert("jobs", {
			organizationId,
			partition: "local",
			group: options.group ?? `${target.kind}:${target.id}`,
			spec:
				options.kind === "noop"
					? { kind: "noop" as const, message: "host" }
					: {
							kind: "application.deploy" as const,
							applicationId: target.id as Id<"applications">,
						},
			status,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
			startedAt: status === "queued" ? undefined : 1000,
			finishedAt:
				status === "queued" || status === "running" ? undefined : 2000,
		});
		await ctx.db.insert("jobLogChunks", { jobId, seq: 0, text: "hello\n" });
		const deploymentId = await ctx.db.insert("deployments", {
			organizationId,
			jobId,
			target,
			title: `${status} deployment`,
		});
		return { jobId, deploymentId };
	});

describe("jobs.deployments", () => {
	test("lists any target's history with job status, scoped to the organization", async () => {
		const { t, alice, applicationId } = await seed();
		const target = { kind: "application", id: applicationId };
		await addDeployment(t, target, "succeeded");
		await addDeployment(t, target, "running");
		await addDeployment(t, target, "failed", { organizationId: "org2" });

		const rows = await alice.query(api.jobs.deployments, {
			organizationId: "org1",
			target,
		});
		expect(rows.map((row) => row.status)).toEqual(["running", "succeeded"]);
		expect(rows[1]).toMatchObject({
			title: "succeeded deployment",
			startedAt: 1000,
			finishedAt: 2000,
		});

		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.jobs.deployments, { organizationId: "org1", target }),
		).rejects.toThrow(/access to this history/);
		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		expect(
			await mallory.query(api.jobs.deployments, {
				organizationId: "org1",
				target,
			}),
		).toHaveLength(2);
		await expect(
			asUser(t, "eve").query(api.jobs.deployments, {
				organizationId: "org1",
				target,
			}),
		).rejects.toThrow(/Not a member/);
		expect(
			await asUser(t, "eve").query(api.jobs.deployments, {
				organizationId: "org2",
				target,
			}),
		).toHaveLength(1);
	});

	test("host targets are not for members", async () => {
		const { t, alice } = await seed();
		const target = { kind: "server", id: "local" };
		await addDeployment(t, target, "succeeded", { kind: "noop" });
		expect(
			await alice.query(api.jobs.deployments, {
				organizationId: "org1",
				target,
			}),
		).toHaveLength(1);
		await expect(
			asUser(t, "mallory").query(api.jobs.deployments, {
				organizationId: "org1",
				target,
			}),
		).rejects.toThrow(/access to this history/);
	});
});

describe("application deployment queue", () => {
	test("cleanQueues cancels queued deploys, killBuild running ones; members need the service", async () => {
		const { t, alice, applicationId } = await seed();
		const target = { kind: "application", id: applicationId };
		const group = `application:${applicationId}`;
		const queued = await addDeployment(t, target, "queued", { group });
		const running = await addDeployment(t, target, "running", { group });

		await expect(
			asUser(t, "mallory").mutation(api.applications.deploy.cleanQueues, {
				applicationId,
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "eve").mutation(api.applications.deploy.killBuild, {
				applicationId,
			}),
		).rejects.toThrow();

		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		expect(
			await asUser(t, "mallory").mutation(api.applications.deploy.cleanQueues, {
				applicationId,
			}),
		).toEqual({ cancelled: 1 });
		const afterClean = await t.run(async (ctx) => ({
			queued: await ctx.db.get("jobs", queued.jobId),
			running: await ctx.db.get("jobs", running.jobId),
		}));
		expect(afterClean.queued?.status).toBe("cancelled");
		expect(afterClean.running?.cancelRequested).toBe(false);

		expect(
			await alice.mutation(api.applications.deploy.killBuild, {
				applicationId,
			}),
		).toEqual({ cancelled: 1 });
		const killed = await t.run((ctx) => ctx.db.get("jobs", running.jobId));
		expect(killed).toMatchObject({ status: "running", cancelRequested: true });
	});

	test("clearDeployments keeps active runs and the latest success, and purges logs", async () => {
		const { t, alice, applicationId } = await seed();
		const target = { kind: "application", id: applicationId };
		const oldSuccess = await addDeployment(t, target, "succeeded");
		const failed = await addDeployment(t, target, "failed");
		const latestSuccess = await addDeployment(t, target, "succeeded");
		const running = await addDeployment(t, target, "running");
		await t.run((ctx) =>
			ctx.db.insert("applicationRollbacks", {
				organizationId: "org1",
				applicationId,
				deploymentId: oldSuccess.deploymentId,
				version: 1,
				image: "web:v1",
				localTag: "web:v1",
			}),
		);

		await expect(
			asUser(t, "mallory").mutation(api.applications.deploy.clearDeployments, {
				applicationId,
			}),
		).rejects.toThrow(/access to this service/);

		expect(
			await alice.mutation(api.applications.deploy.clearDeployments, {
				applicationId,
			}),
		).toEqual({ removed: 2 });
		await t.finishAllScheduledFunctions(() => {});

		const state = await t.run(async (ctx) => ({
			deployments: (await ctx.db.query("deployments").collect()).map(
				(row) => row._id,
			),
			chunks: (await ctx.db.query("jobLogChunks").collect()).map(
				(chunk) => chunk.jobId,
			),
			rollbacks: await ctx.db.query("applicationRollbacks").collect(),
		}));
		expect(state.deployments.sort()).toEqual(
			[latestSuccess.deploymentId, running.deploymentId].sort(),
		);
		expect(state.chunks).not.toContain(oldSuccess.jobId);
		expect(state.chunks).not.toContain(failed.jobId);
		expect(state.chunks).toContain(latestSuccess.jobId);
		expect(state.rollbacks[0]?.deploymentId).toBeUndefined();
	});

	test("webhookBaseUrl points at the Convex site and needs service.create", async () => {
		const { t, alice } = await seed();
		expect(
			await alice.query(api.applications.deploy.webhookBaseUrl, {
				organizationId: "org1",
			}),
		).toBe(`${SITE_URL}/api/deploy`);
		await expect(
			asUser(t, "mallory").query(api.applications.deploy.webhookBaseUrl, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/service\.create/);
	});
});

describe("previews.listByApplication", () => {
	test("includes each preview's domain", async () => {
		const { t, alice, applicationId } = await seed();
		const previewId = await t.run(async (ctx) => {
			const previewId = await ctx.db.insert("applicationPreviews", {
				organizationId: "org1",
				applicationId,
				appName: "preview-web-1",
				host: "pr-1.example.test",
				pullRequest: {
					id: "1",
					number: 1,
					url: "https://github.com/acme/web/pull/1",
					title: "Add feature",
					branch: "feature",
				},
				status: "done",
			});
			const domainId = await ctx.db.insert("domains", {
				organizationId: "org1",
				owner: { kind: "preview", id: previewId },
				host: "pr-1.example.test",
				path: "/",
				port: 3000,
				https: true,
				certificateType: "letsencrypt",
				internalPath: "/",
				stripPath: false,
				middlewares: [],
				enabled: true,
			});
			await ctx.db.patch("applicationPreviews", previewId, { domainId });
			return previewId;
		});
		const rows = await alice.query(
			api.applications.previews.listByApplication,
			{ applicationId },
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			_id: previewId,
			domain: { host: "pr-1.example.test", https: true, path: "/" },
		});
		await expect(
			asUser(t, "eve").query(api.applications.previews.listByApplication, {
				applicationId,
			}),
		).rejects.toThrow(/Not a member/);
	});
});
