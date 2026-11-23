import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const firstPage = { numItems: 50, cursor: null };

const setupOrg = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Storefront" },
	);
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "Stack",
	});
	return { t, alice, projectId, environmentId, applicationId, composeId };
};

const recordDeploy = (
	t: ReturnType<typeof setup>,
	applicationId: string,
	status: "queued" | "failed" = "queued",
) =>
	t.run(async (ctx) => {
		const jobId = await ctx.db.insert("jobs", {
			organizationId: "org1",
			partition: "local",
			group: `application:${applicationId}`,
			spec: {
				kind: "application.deploy",
				applicationId: applicationId as Id<"applications">,
			},
			status,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
		});
		await ctx.db.insert("deployments", {
			organizationId: "org1",
			jobId,
			target: { kind: "application", id: applicationId },
			title: "Deploy",
		});
		return jobId;
	});

describe("overview", () => {
	test("lists the organization's services with their placement", async () => {
		const { t, alice, projectId, environmentId, applicationId, composeId } =
			await setupOrg();
		await recordDeploy(t, applicationId);
		expect(
			await asUser(t, "mallory").query(api.platform.overview.services, {
				organizationId: "org1",
			}),
		).toEqual([]);
		await grantMember(t, "org1", "mallory", {
			services: [applicationId, composeId],
		});
		const services = await asUser(t, "mallory").query(
			api.platform.overview.services,
			{ organizationId: "org1" },
		);
		expect(services.map((s) => [s.type, s.name]).sort()).toEqual([
			["application", "Storefront"],
			["compose", "Stack"],
		]);
		const app = services.find((s) => s.type === "application");
		expect(app).toMatchObject({
			id: applicationId,
			projectId,
			projectName: "Shop",
			environmentId,
			environmentName: "production",
			serverId: null,
		});
		expect(app?.lastDeployAt).not.toBeNull();
		expect(services.find((s) => s.type === "compose")?.lastDeployAt).toBeNull();
		await expect(
			asUser(t, "eve").query(api.platform.overview.services, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("lists domains, deployments and the queue", async () => {
		const { t, alice, applicationId } = await setupOrg();
		await alice.mutation(api.infra.domains.create, {
			owner: { kind: "application", id: applicationId },
			host: "shop.example.com",
			port: 3000,
			https: false,
			certificateType: "none",
		});
		const domains = await alice.query(api.platform.overview.domains, {
			organizationId: "org1",
		});
		expect(domains).toMatchObject([
			{
				host: "shop.example.com",
				port: 3000,
				serviceOwnerType: "application",
				serviceOwnerId: applicationId,
				serviceName: "Storefront",
				projectName: "Shop",
			},
		]);

		await recordDeploy(t, applicationId);
		const { page: deployments } = await alice.query(
			api.platform.overview.deployments,
			{ organizationId: "org1", paginationOpts: firstPage },
		);
		expect(deployments).toHaveLength(1);
		expect(deployments[0]).toMatchObject({
			status: "running",
			service: { type: "application", id: applicationId, name: "Storefront" },
		});
		const queue = await alice.query(api.platform.overview.queue, {
			organizationId: "org1",
		});
		expect(
			queue.find((job) => job.kind === "application.deploy"),
		).toMatchObject({
			state: "waiting",
			service: { id: applicationId },
		});

		await t.run(async (ctx) => {
			await ctx.db.patch("jobs", deployments[0]?.jobId as Id<"jobs">, {
				status: "failed",
				error: "boom",
			});
		});
		const { page: after } = await alice.query(
			api.platform.overview.deployments,
			{ organizationId: "org1", paginationOpts: firstPage },
		);
		expect(after[0]).toMatchObject({ status: "error", errorMessage: "boom" });
		await expect(
			asUser(t, "eve").query(api.platform.overview.deployments, {
				organizationId: "org1",
				paginationOpts: firstPage,
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("backups list runs with their destination and service", async () => {
		const { t, alice } = await setupOrg();
		expect(
			await alice.query(api.platform.overview.backups, {
				organizationId: "org1",
			}),
		).toEqual([]);
		await t.run(async (ctx) => {
			const destinationId = await ctx.db.insert("destinations", {
				organizationId: "org1",
				name: "S3",
				accessKey: "key",
				bucket: "b",
				region: "r",
				endpoint: "https://s3.example.com",
				additionalFlags: [],
			});
			const panelBackupId = await ctx.db.insert("panelBackups", {
				organizationId: "org1",
				destinationId,
				prefix: "panel",
				cronExpression: "0 0 * * *",
				enabled: true,
				generation: 0,
			});
			const jobId = await ctx.db.insert("jobs", {
				organizationId: "org1",
				partition: "local",
				group: "g",
				spec: { kind: "noop", message: "x" },
				status: "succeeded",
				attempts: 1,
				maxAttempts: 1,
				idempotent: false,
				cancelRequested: false,
			});
			await ctx.db.insert("deployments", {
				organizationId: "org1",
				jobId,
				target: { kind: "panelBackup", id: panelBackupId },
				title: "Panel backup",
			});
		});
		const backups = await alice.query(api.platform.overview.backups, {
			organizationId: "org1",
		});
		expect(backups).toMatchObject([
			{
				kind: "backup",
				status: "done",
				destinationName: "S3",
				serviceOwnerType: "web-server",
			},
		]);
	});
});
