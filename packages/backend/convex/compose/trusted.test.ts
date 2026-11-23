import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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

const COMPOSE = "services:\n  web:\n    image: nginx:alpine\n";

const createCompose = async (
	t: TestConvex,
	userId: string,
	organizationId: string,
	serverId?: Id<"servers">,
) => {
	const { environmentId } = await asUser(t, userId).mutation(
		api.projects.create,
		{ organizationId, name: "Shop" },
	);
	return await asUser(t, userId).mutation(api.compose.crud.create, {
		environmentId,
		name: "Stack",
		composeFile: COMPOSE,
		...(serverId ? { serverId } : {}),
	});
};

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

describe("compose deploys carry the trusted flag only for the instance admin", () => {
	test("instance admin deploys of root organization services are trusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		const admin = asUser(t, "admin");
		const { jobId } = await admin.mutation(api.compose.deploy.deploy, {
			composeId,
		});
		expect(await specOf(t, jobId)).toMatchObject({ trusted: true });
		const redeploy = await admin.mutation(api.compose.deploy.redeploy, {
			composeId,
		});
		expect(await specOf(t, redeploy.jobId)).toMatchObject({ trusted: true });

		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		const claim = await agent.mutation(api.agent.claimNext, {});
		const context = await agent.query(api.compose.agent.getContext, {
			jobId: claim?.jobId as Id<"jobs">,
			leaseId: claim?.leaseId as string,
		});
		expect(context?.trusted).toBe(true);
	});

	test("root organization members are not trusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await grantMember(t, "org1", "bob", { services: [composeId] });
		const { jobId } = await asUser(t, "bob").mutation(
			api.compose.deploy.deploy,
			{ composeId },
		);
		expect(
			(await specOf(t, jobId)) as { trusted?: boolean },
		).not.toHaveProperty("trusted");
	});

	test("other organizations' owners are not trusted, even from webhooks", async () => {
		const { t, serverId } = await seed();
		const composeId = await createCompose(t, "eve", "org2", serverId);
		const { jobId } = await asUser(t, "eve").mutation(
			api.compose.deploy.deploy,
			{ composeId },
		);
		expect(await specOf(t, jobId)).not.toHaveProperty("trusted");
		const hook = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, hook.jobId)).not.toHaveProperty("trusted");
	});

	test("webhook deploys of root organization services stay trusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		const hook = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, hook.jobId)).toMatchObject({ trusted: true });
	});

	test("a member's edit makes webhook deploys untrusted until an admin saves again", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await grantMember(t, "org1", "bob", {
			services: [composeId],
			flags: { canCreateServices: true },
		});
		const bob = asUser(t, "bob");
		await bob.mutation(api.compose.crud.saveFile, {
			composeId,
			composeFile: "services:\n  x:\n    image: alpine\n    privileged: true\n",
		});
		const hook = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, hook.jobId)).not.toHaveProperty("trusted");

		await asUser(t, "admin").mutation(api.compose.crud.saveFile, {
			composeId,
			composeFile: COMPOSE,
		});
		const again = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, again.jobId)).toMatchObject({ trusted: true });
	});

	test("members rotating the webhook token neither see it nor keep trust", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await grantMember(t, "org1", "bob", {
			services: [composeId],
			flags: { canCreateServices: true },
		});
		const token = await asUser(t, "bob").mutation(
			api.compose.crud.regenerateRefreshToken,
			{ composeId },
		);
		expect(token).toBeNull();
		const hook = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, hook.jobId)).not.toHaveProperty("trusted");
		expect(
			typeof (await asUser(t, "admin").mutation(
				api.compose.crud.regenerateRefreshToken,
				{ composeId },
			)),
		).toBe("string");
	});

	test("webhook deploys of compose with no recorded author are untrusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await t.run((ctx) =>
			ctx.db.patch("compose", composeId, { configuredBy: undefined }),
		);
		const hook = await t.mutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId,
			title: "push",
		});
		expect(await specOf(t, hook.jobId)).not.toHaveProperty("trusted");
	});
});
