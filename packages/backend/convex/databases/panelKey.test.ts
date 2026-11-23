import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import { PANEL_SECRET_ENV } from "./agent";

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	const destinationId = await asUser(t, "alice").action(
		api.databases.destinations.create,
		{
			organizationId: "org1",
			name: "s3",
			accessKey: "a",
			bucket: "panel",
			region: "us-east-1",
			endpoint: "http://10.0.0.5:9000",
			additionalFlags: [],
			secretAccessKey: "secret",
		},
	);
	return destinationId;
};

const args = (destinationId: Id<"destinations">) => ({
	destinationId,
	cronExpression: "0 3 * * *",
	enabled: false,
	prefix: "nightly",
});

const runContext = async (t: TestConvex, panelBackupId: Id<"panelBackups">) => {
	const agent = asAgent(t, await addAgent(t));
	const jobId = await asUser(t, "alice").mutation(
		api.databases.panelBackups.runNow,
		{ panelBackupId },
	);
	const claimed = await agent.mutation(api.agent.claimNext, {});
	expect(claimed?.jobId).toBe(jobId);
	const context = await agent.query(api.databases.agent.getPanelBackupContext, {
		jobId: jobId as Id<"jobs">,
		leaseId: claimed?.leaseId ?? "",
	});
	await t.run((ctx) =>
		ctx.db.patch("jobs", jobId as Id<"jobs">, { status: "succeeded" }),
	);
	return context;
};

describe("panel backups: include encryption key", () => {
	test("the agent gets the deployment secrets only when the backup includes them", async () => {
		const t = setup();
		const destinationId = await seed(t);
		const alice = asUser(t, "alice");
		const withKey = await alice.mutation(api.databases.panelBackups.create, {
			...args(destinationId),
			includeEncryptionKey: true,
		});
		const listed = await alice.query(api.databases.panelBackups.list, {});
		expect(listed[0]?.includeEncryptionKey).toBe(true);
		const { secrets } = await runContext(t, withKey);
		expect(secrets).toContainEqual({
			name: "SECRETS_KEY",
			value: process.env.SECRETS_KEY,
		});
		for (const { name, value } of secrets) {
			expect(PANEL_SECRET_ENV).toContain(name);
			expect(value).toBe(process.env[name]);
		}

		await alice.mutation(api.databases.panelBackups.update, {
			panelBackupId: withKey,
			...args(destinationId),
			includeEncryptionKey: false,
		});
		expect((await runContext(t, withKey)).secrets).toEqual([]);

		const legacy = await alice.mutation(
			api.databases.panelBackups.create,
			args(destinationId),
		);
		expect((await runContext(t, legacy)).secrets).toEqual([]);
	});

	test("members cannot turn it on", async () => {
		const t = setup();
		const destinationId = await seed(t);
		await expect(
			asUser(t, "bob").mutation(api.databases.panelBackups.create, {
				...args(destinationId),
				includeEncryptionKey: true,
			}),
		).rejects.toThrow(/instance administrator/);
	});
});
