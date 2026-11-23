import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "key",
		publicKey: "ssh-ed25519 AAAAC3Nza test",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	const server = (name: string, serverType: "deploy" | "build") =>
		alice.mutation(api.servers.create, {
			organizationId: "org1",
			name,
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			sshKeyId,
			serverType,
			enableDockerCleanup: false,
		});
	const deployServer = await server("web-1", "deploy");
	const buildServer = await server("builder", "build");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Storefront" },
	);
	await t.run((ctx) =>
		ctx.db.patch("applications", applicationId as Id<"applications">, {
			serverId: deployServer,
			buildServerId: buildServer,
		}),
	);
	return { t, alice, applicationId, deployServer };
};

const insertJob = (
	t: TestConvex,
	input: {
		organizationId?: string;
		partition: string;
		status: "queued" | "running" | "succeeded";
		applicationId: string;
		deployment?: boolean;
	},
) =>
	t.run(async (ctx) => {
		const organizationId = input.organizationId ?? "org1";
		const jobId = await ctx.db.insert("jobs", {
			organizationId,
			partition: input.partition,
			group: `application:${input.applicationId}`,
			spec: {
				kind: "application.deploy",
				applicationId: input.applicationId as Id<"applications">,
			},
			status: input.status,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
		});
		if (input.deployment !== false) {
			await ctx.db.insert("deployments", {
				organizationId,
				jobId,
				target: { kind: "application", id: input.applicationId },
				title: "Deploy",
			});
		}
		return jobId;
	});

describe("deployments overview", () => {
	test("pages through every deployment with server badges", async () => {
		const { t, alice, applicationId, deployServer } = await seed();
		for (let i = 0; i < 5; i++) {
			await insertJob(t, {
				partition: deployServer,
				status: "succeeded",
				applicationId,
			});
		}
		// Many unrelated jobs don't push deployments out of the list.
		for (let i = 0; i < 20; i++) {
			await insertJob(t, {
				partition: "local",
				status: "succeeded",
				applicationId,
				deployment: false,
			});
		}
		const first = await alice.query(api.platform.overview.deployments, {
			organizationId: "org1",
			paginationOpts: { numItems: 3, cursor: null },
		});
		expect(first.page).toHaveLength(3);
		expect(first.isDone).toBe(false);
		expect(first.page[0]).toMatchObject({
			status: "done",
			server: { name: "web-1", serverType: "deploy" },
			buildServer: { name: "builder", serverType: "build" },
		});
		const second = await alice.query(api.platform.overview.deployments, {
			organizationId: "org1",
			paginationOpts: { numItems: 3, cursor: first.continueCursor },
		});
		expect(second.page).toHaveLength(2);
		expect(second.isDone).toBe(true);
		await expect(
			asUser(t, "eve").query(api.platform.overview.deployments, {
				organizationId: "org1",
				paginationOpts: { numItems: 3, cursor: null },
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("the queue keeps old waiting jobs and other organizations' jobs out", async () => {
		const { t, alice, applicationId } = await seed();
		const waiting = await insertJob(t, {
			partition: "local",
			status: "queued",
			applicationId,
		});
		for (let i = 0; i < 10; i++) {
			await insertJob(t, {
				partition: "local",
				status: "succeeded",
				applicationId,
			});
		}
		const running = await insertJob(t, {
			partition: "local",
			status: "running",
			applicationId,
		});
		await insertJob(t, {
			organizationId: "org2",
			partition: "local",
			status: "queued",
			applicationId,
		});
		const queue = await alice.query(api.platform.overview.queue, {
			organizationId: "org1",
		});
		expect(
			queue
				.filter((job) => job.kind === "application.deploy")
				.map((job) => [job.jobId, job.state]),
		).toEqual([
			[running, "active"],
			[waiting, "waiting"],
		]);
		expect(
			await alice.query(api.platform.overview.queue, {
				organizationId: "org1",
			}),
		).toHaveLength(queue.length);
	});
});
