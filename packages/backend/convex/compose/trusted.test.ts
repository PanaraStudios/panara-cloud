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

	test("a start carries the same trust as a deploy, decided when it runs", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await t.run((ctx) =>
			ctx.db.patch("compose", composeId, { status: "done" }),
		);
		const start = await asUser(t, "admin").mutation(api.compose.deploy.start, {
			composeId,
		});
		// Decided when the agent reads the job: the stored spec keeps the
		// shape older releases accept.
		expect(await specOf(t, start)).toEqual({
			kind: "compose.start",
			composeId,
		});
		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		await agent.mutation(api.agent.hello, {
			version: "0.1.7",
			capabilities: ["compose.start", "compose.snapshots"],
		});
		const claim = await agent.mutation(api.agent.claimNext, {});
		const context = await agent.query(api.compose.agent.getContext, {
			jobId: claim?.jobId as Id<"jobs">,
			leaseId: claim?.leaseId as string,
		});
		expect(context?.trusted).toBe(true);
	});

	test("an older agent, which would start from the service's folder, is never told a start is trusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await t.run((ctx) =>
			ctx.db.patch("compose", composeId, { status: "done" }),
		);
		await asUser(t, "admin").mutation(api.compose.deploy.start, {
			composeId,
		});
		const agent = asAgent(t, await addAgent(t));
		await agent.mutation(api.agent.hello, {
			version: "0.1.6",
			capabilities: ["compose.start"],
		});
		const claim = await agent.mutation(api.agent.claimNext, {});
		const context = await agent.query(api.compose.agent.getContext, {
			jobId: claim?.jobId as Id<"jobs">,
			leaseId: claim?.leaseId as string,
		});
		expect(context?.trusted).toBe(false);
	});

	test("a member's start is not trusted", async () => {
		const { t } = await seed();
		const composeId = await createCompose(t, "admin", "org1");
		await grantMember(t, "org1", "bob", { services: [composeId] });
		await t.run((ctx) =>
			ctx.db.patch("compose", composeId, { status: "done" }),
		);
		const start = await asUser(t, "bob").mutation(api.compose.deploy.start, {
			composeId,
		});
		expect(await specOf(t, start)).not.toHaveProperty("trusted");
		const agent = asAgent(t, await addAgent(t));
		await agent.mutation(api.agent.hello, {
			version: "0.1.7",
			capabilities: ["compose.start", "compose.snapshots"],
		});
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(start);
		const context = await agent.query(api.compose.agent.getContext, {
			jobId: claim?.jobId as Id<"jobs">,
			leaseId: claim?.leaseId as string,
		});
		expect(context?.trusted).toBe(false);
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
