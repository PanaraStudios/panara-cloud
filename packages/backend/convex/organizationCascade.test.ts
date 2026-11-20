import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { addMember, asUser, setup, type TestConvex } from "./test.setup";

const events = {
	appDeploy: true,
	appBuildError: true,
	databaseBackup: false,
	volumeBackup: false,
	dockerCleanup: false,
	serverThreshold: false,
	panelRestart: false,
	panelBackup: false,
};

const seedOrganization = async (
	t: TestConvex,
	organizationId: string,
	userId: string,
) => {
	await addMember(t, organizationId, userId, "owner");
	const user = asUser(t, userId);
	const sshKeyId = await user.action(api.sshKeys.create, {
		organizationId,
		name: "deploy key",
		publicKey: "ssh-ed25519 AAAAC3Nza panel",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	const serverId = await user.mutation(api.servers.create, {
		organizationId,
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup: true,
	});
	const { projectId, environmentId } = await user.mutation(
		api.projects.create,
		{ organizationId, name: "Shop" },
	);
	for (const name of ["web", "api"]) {
		await user.mutation(api.applications.applications.create, {
			environmentId,
			name,
			serverId,
		});
	}
	const tagId = await user.mutation(api.platform.tags.create, {
		organizationId,
		name: "prod",
	});
	await user.mutation(api.platform.tags.assignToProject, { projectId, tagId });
	await t.run(async (ctx) => {
		await ctx.db.insert("notifications", {
			organizationId,
			name: "team",
			channel: { type: "discord", decoration: true },
			events,
		});
		const apiKeyId = await ctx.db.insert("apiKeys", {
			organizationId,
			userId,
			name: "ci",
			prefix: "pnr_abc",
			hash: `hash-${organizationId}`,
		});
		await ctx.db.insert("apiRateLimits", {
			key: apiKeyId,
			windowStart: 0,
			count: 1,
		});
		await ctx.db.insert("secrets", {
			organizationId,
			kind: "test.secret",
			ownerId: "x",
			iv: "iv",
			ciphertext: "c",
		});
		const jobId = await ctx.db.insert("jobs", {
			organizationId,
			partition: serverId,
			group: "noop",
			spec: { kind: "noop", message: "done" },
			status: "succeeded",
			attempts: 1,
			maxAttempts: 1,
			idempotent: true,
			cancelRequested: false,
		});
		for (let seq = 0; seq < 3; seq++) {
			await ctx.db.insert("jobLogChunks", { jobId, seq, text: "line" });
		}
		await ctx.db.insert("deployments", {
			organizationId,
			jobId,
			target: { kind: "application", id: "x" },
			title: "Deploy",
		});
	});
};

const orgTables: TableNames[] = [
	"projects",
	"environments",
	"applications",
	"servers",
	"sshKeys",
	"tags",
	"projectTags",
	"notifications",
	"apiKeys",
	"secrets",
	"jobs",
	"deployments",
	"memberships",
];

const countFor = (t: TestConvex, organizationId: string) =>
	t.run(async (ctx) => {
		const counts: Record<string, number> = {};
		for (const table of orgTables) {
			const rows = (await ctx.db.query(table).collect()) as {
				organizationId?: string;
			}[];
			counts[table] = rows.filter(
				(row) => row.organizationId === organizationId,
			).length;
		}
		return counts;
	});

afterEach(() => {
	vi.useRealTimers();
});

describe("organization cascade", () => {
	test("deleting an organization removes its data and leaves other organizations alone", async () => {
		vi.useFakeTimers();
		const t = setup();
		await seedOrganization(t, "org1", "alice");
		await seedOrganization(t, "org2", "bob");
		const before = await countFor(t, "org2");

		// The Better Auth `organization` delete trigger starts the cascade.
		await t.mutation(internal.auth.onDelete, {
			model: "organization",
			doc: { _id: "org1" },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);

		const after = await countFor(t, "org1");
		expect(Object.entries(after).filter(([, count]) => count > 0)).toEqual([]);
		expect(await countFor(t, "org2")).toEqual(before);
		const leftovers = await t.run(async (ctx) => ({
			chunks: (await ctx.db.query("jobLogChunks").collect()).length,
			rateLimits: (await ctx.db.query("apiRateLimits").collect()).length,
		}));
		expect(leftovers).toEqual({ chunks: 3, rateLimits: 1 });
	});

	test("waits for queued removal jobs before deleting servers", async () => {
		vi.useFakeTimers();
		const t = setup();
		await seedOrganization(t, "org1", "alice");
		await t.mutation(internal.organizationCascade.run, {
			organizationId: "org1",
		});
		// Run the immediate cascades but stay inside the first wait.
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(10);
			await t.finishInProgressScheduledFunctions();
		}
		// The application cascade enqueued agent removal jobs on the server.
		const state = await t.run(async (ctx) => ({
			servers: (await ctx.db.query("servers").collect()).length,
			queued: (await ctx.db.query("jobs").collect()).filter(
				(job) => job.status === "queued",
			).length,
		}));
		expect(state.servers).toBe(1);
		expect(state.queued).toBeGreaterThan(0);
	});
});
