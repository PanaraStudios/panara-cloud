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
import { enqueueJob } from "./jobs";

const specOf = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run(async (ctx) => (await ctx.db.get("jobs", jobId))?.spec);

// The instance's root organization is org1 (oldest membership).
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "admin", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const serverId = await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId: "org2",
			name: "eve's",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: true,
		}),
	);
	return { t, serverId };
};

const createApp = async (
	t: TestConvex,
	userId: string,
	organizationId: string,
	serverId?: Id<"servers">,
) => {
	const { environmentId } = await asUser(t, userId).mutation(
		api.projects.create,
		{ organizationId, name: "Shop" },
	);
	return await asUser(t, userId).mutation(
		api.applications.applications.create,
		{
			environmentId,
			name: "Web",
			...(serverId ? { serverId } : {}),
		},
	);
};

const createDatabase = async (
	t: TestConvex,
	userId: string,
	organizationId: string,
	serverId?: Id<"servers">,
) => {
	const { environmentId } = await asUser(t, userId).mutation(
		api.projects.create,
		{ organizationId, name: "Data" },
	);
	return await asUser(t, userId).action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "pg",
		...(serverId ? { serverId } : {}),
	});
};

describe("application and database jobs carry the trusted flag only for the instance admin", () => {
	test("root organization admins' jobs are trusted and the agent sees it", async () => {
		const { t } = await seed();
		const admin = asUser(t, "admin");
		const applicationId = await createApp(t, "admin", "org1");
		for (const fn of [
			api.applications.deploy.start,
			api.applications.deploy.reload,
		]) {
			const jobId = await admin.mutation(fn, { applicationId });
			expect(await specOf(t, jobId)).toMatchObject({ trusted: true });
		}
		const databaseId = await createDatabase(t, "admin", "org1");
		for (const fn of [
			api.databases.databases.deploy,
			api.databases.databases.start,
			api.databases.databases.reload,
			api.databases.databases.rebuild,
		]) {
			const jobId = await admin.mutation(fn, { databaseId });
			expect(await specOf(t, jobId)).toMatchObject({ trusted: true });
		}

		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.spec).toMatchObject({ trusted: true });
	});

	test("root organization members and other organizations' owners are not trusted", async () => {
		const { t, serverId } = await seed();
		const applicationId = await createApp(t, "admin", "org1");
		await grantMember(t, "org1", "bob", { services: [applicationId] });
		const bobJob = await asUser(t, "bob").mutation(
			api.applications.deploy.start,
			{ applicationId },
		);
		expect(await specOf(t, bobJob)).not.toHaveProperty("trusted");

		const eveApp = await createApp(t, "eve", "org2", serverId);
		const eveJob = await asUser(t, "eve").mutation(
			api.applications.deploy.reload,
			{ applicationId: eveApp },
		);
		expect(await specOf(t, eveJob)).not.toHaveProperty("trusted");
		const eveDb = await createDatabase(t, "eve", "org2", serverId);
		const dbJob = await asUser(t, "eve").mutation(
			api.databases.databases.deploy,
			{ databaseId: eveDb },
		);
		expect(await specOf(t, dbJob)).not.toHaveProperty("trusted");
	});

	test("the flag is recomputed at enqueue: forged for others, kept for root webhooks", async () => {
		const { t, serverId } = await seed();
		const eveApp = await createApp(t, "eve", "org2", serverId);
		const rootApp = await createApp(t, "admin", "org1");
		const [forged, webhook] = await t.run(async (ctx) => [
			await enqueueJob(ctx, {
				organizationId: "org2",
				partition: serverId,
				group: `application:${eveApp}`,
				spec: {
					kind: "application.deploy",
					applicationId: eveApp,
					trusted: true,
				},
				idempotent: false,
			}),
			await enqueueJob(ctx, {
				organizationId: "org1",
				partition: "local",
				group: `application:${rootApp}`,
				spec: { kind: "application.deploy", applicationId: rootApp },
				idempotent: false,
			}),
		]);
		expect(await specOf(t, forged)).not.toHaveProperty("trusted");
		expect(await specOf(t, webhook)).toMatchObject({ trusted: true });
	});
});
