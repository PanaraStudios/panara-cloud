import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const RESTORE_PASSWORD_KIND = "databases.restorePassword";

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "shop",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		composeFile: "services:\n  db:\n    image: mariadb\n",
	});
	const destinationId = await alice.action(api.databases.destinations.create, {
		organizationId: "org1",
		name: "minio",
		accessKey: "a",
		bucket: "b",
		region: "us-east-1",
		endpoint: "http://10.0.0.5:9000",
		additionalFlags: [],
		secretAccessKey: "secret",
	});
	return { composeId, destinationId };
};

const restoreArgs = (
	composeId: Id<"compose">,
	destinationId: Id<"destinations">,
) => ({
	composeId,
	serviceName: "db",
	destinationId,
	backupFile: "stack/db/2026.sql.gz",
	databaseName: "shop",
	databaseType: "mariadb" as const,
	databaseUser: "shop",
	databasePassword: "s3cret-pass",
});

const restoreSecret = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run((ctx) =>
		ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", RESTORE_PASSWORD_KIND).eq("ownerId", jobId),
			)
			.unique(),
	);

describe("compose restores with typed credentials", () => {
	test("the agent gets the form's credentials; the password goes once the restore ends", async () => {
		const t = setup();
		const { composeId, destinationId } = await seed(t);
		const agent = asAgent(t, await addAgent(t));
		await expect(
			asUser(t, "bob").action(
				api.databases.backups.restoreCompose,
				restoreArgs(composeId, destinationId),
			),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [composeId] });
		// Scoped members restore from their own services' backup folders only.
		await expect(
			asUser(t, "bob").action(
				api.databases.backups.restoreCompose,
				restoreArgs(composeId, destinationId),
			),
		).rejects.toThrow(/backup folder of a service you have access to/);
		const appName = await t.run(
			async (ctx) => (await ctx.db.get("compose", composeId))?.appName,
		);
		const jobId = await asUser(t, "bob").action(
			api.databases.backups.restoreCompose,
			{
				...restoreArgs(composeId, destinationId),
				backupFile: `${appName}_db/2026.sql.gz`,
			},
		);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toMatchObject({
			kind: "databases.restore",
			owner: { kind: "compose", id: composeId },
			serviceName: "db",
			databaseUser: "shop",
		});
		expect(JSON.stringify(job?.spec)).not.toContain("s3cret-pass");
		const secret = await restoreSecret(t, jobId);
		expect(secret?.ciphertext).not.toContain("s3cret-pass");

		const claimed = await agent.mutation(api.agent.claimNext, {});
		expect(claimed?.jobId).toBe(jobId);
		const lease = { jobId, leaseId: claimed?.leaseId ?? "" };
		const context = await agent.query(
			api.databases.agent.getRestoreContext,
			lease,
		);
		expect(context.credentials).toEqual({
			databaseUser: "shop",
			password: "s3cret-pass",
			rootPassword: undefined,
		});
		expect(context.target).toMatchObject({
			kind: "compose",
			serviceName: "db",
		});

		await expect(
			asUser(t, "alice").mutation(api.databases.agent.finishRestore, lease),
		).rejects.toThrow();
		await agent.mutation(api.databases.agent.finishRestore, lease);
		expect(await restoreSecret(t, jobId)).toBeNull();
	});

	test("requires the credentials the restore form asks for", async () => {
		const t = setup();
		const { composeId, destinationId } = await seed(t);
		const alice = asUser(t, "alice");
		const args = restoreArgs(composeId, destinationId);
		await expect(
			alice.action(api.databases.backups.restoreCompose, {
				...args,
				databasePassword: undefined,
			}),
		).rejects.toThrow(/Database password is required/);
		await expect(
			alice.action(api.databases.backups.restoreCompose, {
				...args,
				databaseType: "postgres",
				databaseUser: " ",
			}),
		).rejects.toThrow(/Database user is required/);
		await expect(
			alice.action(api.databases.backups.restoreCompose, {
				...args,
				databaseType: "mysql",
				databaseUser: undefined,
				databasePassword: undefined,
			}),
		).rejects.toThrow(/Root password is required/);
		await expect(
			alice.action(api.databases.backups.restoreCompose, {
				...args,
				serviceName: "db; rm -rf /",
			}),
		).rejects.toThrow(/Service name/);
		await expect(
			alice.action(api.databases.backups.restoreCompose, {
				...args,
				backupFile: "../x.sql.gz",
			}),
		).rejects.toThrow(/Invalid backup file/);

		const mysql = await alice.action(api.databases.backups.restoreCompose, {
			...args,
			databaseType: "mysql",
			databaseUser: undefined,
			databasePassword: "rootpw",
		});
		const agent = asAgent(t, await addAgent(t));
		const claimed = await agent.mutation(api.agent.claimNext, {});
		expect(claimed?.jobId).toBe(mysql);
		const context = await agent.query(api.databases.agent.getRestoreContext, {
			jobId: mysql,
			leaseId: claimed?.leaseId ?? "",
		});
		expect(context.credentials).toMatchObject({
			password: "rootpw",
			rootPassword: "rootpw",
		});
	});

	test("other organizations cannot restore into the compose", async () => {
		const t = setup();
		const { composeId, destinationId } = await seed(t);
		await expect(
			asUser(t, "eve").action(
				api.databases.backups.restoreCompose,
				restoreArgs(composeId, destinationId),
			),
		).rejects.toThrow(/Not a member/);
	});

	test("restores stay out of the compose deploy history", async () => {
		const t = setup();
		const { composeId, destinationId } = await seed(t);
		await asUser(t, "alice").action(
			api.databases.backups.restoreCompose,
			restoreArgs(composeId, destinationId),
		);
		expect(
			await asUser(t, "alice").query(api.compose.deploy.listDeployments, {
				composeId,
			}),
		).toEqual([]);
	});
});
