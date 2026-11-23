import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import { hmacSha256Hex } from "../sources/webhooks";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	markDeployed,
	setup,
	type TestConvex,
} from "../test.setup";

type Agent = ReturnType<typeof asAgent>;

const createServer = async (
	t: TestConvex,
	organizationId = "org1",
	ip = "10.0.0.5",
) =>
	await t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: "key",
			publicKey: "ssh-ed25519 AAAA",
		});
		await ctx.db.insert("secrets", {
			organizationId,
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			...(await encryptSecret("PRIVATE KEY")),
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: `server-${ip}`,
			ipAddress: ip,
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
			buildsConcurrency: 2,
			enableDockerCleanup: false,
		});
	});

const seed = async () => {
	const t = setup();
	// The first membership makes org1 the instance's root organization.
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Web" },
	);
	const serverId = await createServer(t);
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, projectId, environmentId, serverId, agent };
};

const createApp = async (
	ctx: Awaited<ReturnType<typeof seed>>,
	extra: { appName?: string; serverId?: Id<"servers"> | null } = {},
) =>
	await ctx.alice.mutation(api.applications.applications.create, {
		environmentId: ctx.environmentId,
		name: "Web",
		appName: extra.appName,
		serverId:
			extra.serverId === null ? undefined : (extra.serverId ?? ctx.serverId),
	});

const gitSource = {
	type: "git" as const,
	url: "https://github.com/acme/web.git",
	branch: "main",
	buildPath: "/",
	submodules: false,
	watchPaths: ["src/**"],
};

const jobsOf = (t: TestConvex) =>
	t.run((ctx) => ctx.db.query("jobs").collect());

// Claims queued jobs until one of `kind` comes up; others are completed so
// they don't hold their group.
const claim = async (agent: Agent, kind: string) => {
	for (let i = 0; i < 50; i++) {
		const next = await agent.mutation(api.agent.claimNext, {});
		if (!next) break;
		const lease = { jobId: next.jobId, leaseId: next.leaseId };
		if (next.spec.kind === kind) return lease;
		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
	}
	throw new Error(`No ${kind} job queued`);
};

const scheduled = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).map(
			(fn) => fn.name,
		),
	);

describe("applications", () => {
	test("admins create; members read; other organizations see nothing", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		const app = await alice.query(api.applications.applications.get, {
			applicationId,
		});
		expect(app?.appName).toMatch(/^app-[a-z0-9-]+-[a-z0-9]{6}$/);
		expect(app).not.toHaveProperty("refreshToken");
		expect(app).toMatchObject({
			status: "idle",
			replicas: 1,
			autoDeploy: true,
		});
		const routing = await t.run((c) => c.db.query("routingOwners").collect());
		expect(routing).toMatchObject([
			{
				owner: { kind: "application", id: applicationId },
				appName: app?.appName,
			},
		]);

		const custom = await createApp(ctx, { appName: "my-app" });
		expect(
			(
				await alice.query(api.applications.applications.get, {
					applicationId: custom,
				})
			)?.appName,
		).toMatch(/^my-app-[a-z0-9]{6}$/);

		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.applications.applications.get, { applicationId }),
		).rejects.toThrow(/access to this service/);
		await expect(createApp({ ...ctx, alice: mallory })).rejects.toThrow(
			/service\.create/,
		);
		await expect(
			mallory.mutation(api.applications.deploy.deploy, { applicationId }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		expect(
			await mallory.query(api.applications.applications.get, { applicationId }),
		).toMatchObject({ name: "Web" });
		await expect(
			mallory.query(api.applications.applications.getWebhookUrl, {
				applicationId,
			}),
		).rejects.toThrow(/service\.create/);
		expect(
			await mallory.query(api.applications.applications.getEnvironment, {
				applicationId,
			}),
		).toMatchObject({ env: "" });
		expect(
			await alice.query(api.applications.applications.getWebhookUrl, {
				applicationId,
			}),
		).toMatch(/^http:\/\/site\.test\/api\/deploy\/[A-Za-z0-9]{32}$/);

		const eve = asUser(t, "eve");
		await expect(
			eve.query(api.applications.applications.get, { applicationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			eve.query(api.applications.applications.listByEnvironment, {
				environmentId: ctx.environmentId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			eve.mutation(api.applications.applications.remove, { applicationId }),
		).rejects.toThrow(/Not a member/);
	});

	test("only the root organization deploys to the panel host; servers must be the org's", async () => {
		const ctx = await seed();
		const local = await createApp(ctx, { serverId: null });
		expect(local).toBeTruthy();
		const eve = asUser(ctx.t, "eve");
		const { environmentId } = await eve.mutation(api.projects.create, {
			organizationId: "org2",
			name: "Other",
		});
		await expect(
			eve.mutation(api.applications.applications.create, {
				environmentId,
				name: "x",
			}),
		).rejects.toThrow(/Requires an instance administrator/);
		await expect(
			eve.mutation(api.applications.applications.create, {
				environmentId,
				name: "x",
				serverId: ctx.serverId,
			}),
		).rejects.toThrow(/Server not found/);
	});

	test("build servers need a registry; builds run there, docker images on the deploy server", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		const buildServerId = await createServer(t, "org1", "10.0.0.9");
		await expect(
			alice.mutation(api.applications.applications.updateTargets, {
				applicationId,
				serverId: ctx.serverId,
				buildServerId,
			}),
		).rejects.toThrow(/needs a registry/);
		const registryId = await t.run((c) =>
			c.db.insert("registries", {
				organizationId: "org1",
				registryName: "hub",
				username: "acme",
				registryUrl: "registry.example.com",
				registryType: "cloud",
			}),
		);
		await alice.mutation(api.applications.applications.updateTargets, {
			applicationId,
			serverId: ctx.serverId,
			buildServerId,
			buildRegistryId: registryId,
		});
		// A build setting that only a deploy applies; the server did not change.
		const staged = await t.run((c) =>
			c.db
				.query("serviceEvents")
				.withIndex("by_target", (q) =>
					q.eq("target.kind", "application").eq("target.id", applicationId),
				)
				.collect(),
		);
		expect(
			staged
				.filter((event) => event.type !== "lifecycle.created")
				.map(({ type, details, appliesOnDeploy, reapply }) => ({
					type,
					fields: details?.fields,
					appliesOnDeploy,
					reapply,
				})),
		).toEqual([
			{
				type: "config.build",
				fields: ["buildServerId", "buildRegistryId"],
				appliesOnDeploy: true,
				reapply: undefined,
			},
		]);
		// The registry the image is deployed from is not a build setting.
		const targets = { applicationId, serverId: ctx.serverId, buildServerId };
		await alice.mutation(api.applications.applications.updateTargets, {
			...targets,
			buildRegistryId: registryId,
			registryId,
		});
		await alice.mutation(api.applications.applications.updateTargets, {
			...targets,
			buildRegistryId: registryId,
		});
		const later = await t.run((c) =>
			c.db
				.query("serviceEvents")
				.withIndex("by_target", (q) =>
					q.eq("target.kind", "application").eq("target.id", applicationId),
				)
				.collect(),
		);
		expect(
			later.slice(staged.length).map(({ type, details }) => ({
				type,
				fields: details?.fields,
			})),
		).toEqual([
			{ type: "config.server", fields: ["registryId"] },
			{ type: "config.server", fields: ["registryId"] },
		]);
		await expect(
			alice.mutation(api.applications.deploy.deploy, { applicationId }),
		).rejects.toThrow(/Configure a source/);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: gitSource,
		});
		const { jobId } = await alice.mutation(api.applications.deploy.deploy, {
			applicationId,
		});
		const job = await t.run((c) => c.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: buildServerId,
			group: `application:${applicationId}`,
			usesBuildSlot: true,
			spec: { kind: "application.deploy", applicationId },
		});

		await alice.action(api.applications.applications.saveDockerSource, {
			applicationId,
			image: "nginx:alpine",
			username: "u",
			password: "docker-pass",
		});
		const { jobId: dockerJob } = await alice.mutation(
			api.applications.deploy.deploy,
			{ applicationId },
		);
		expect((await t.run((c) => c.db.get("jobs", dockerJob)))?.partition).toBe(
			ctx.serverId,
		);
		await markDeployed(ctx.t, "applications", applicationId);
		const stop = await alice.mutation(api.applications.deploy.stop, {
			applicationId,
		});
		expect(await t.run((c) => c.db.get("jobs", stop))).toMatchObject({
			partition: ctx.serverId,
			usesBuildSlot: false,
			spec: { kind: "application.stop" },
		});
	});

	test("the deploy context is lease-guarded and carries decrypted env; results update status and history", async () => {
		vi.useFakeTimers();
		const ctx = await seed();
		const { t, alice, agent } = ctx;
		const applicationId = await createApp(ctx);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: gitSource,
		});
		await alice.action(api.projects.setEnv, {
			projectId: ctx.projectId,
			env: "X=2",
		});
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "A=1\nB=${{project.X}}",
			buildSecrets: "TOKEN=secret",
		});
		expect(
			await alice.query(api.applications.applications.getEnvironment, {
				applicationId,
			}),
		).toMatchObject({
			env: "A=1\nB=${{project.X}}",
			buildSecrets: "TOKEN=secret",
		});
		await alice.mutation(api.applications.patches.save, {
			owner: { kind: "application", id: applicationId },
			filePath: "src/config.ts",
			content: "export const x = 1;",
		});
		const { deploymentId } = await alice.mutation(
			api.applications.deploy.deploy,
			{
				applicationId,
				title: "First",
			},
		);
		const lease = await claim(agent, "application.deploy");

		await expect(
			alice.query(api.applications.agent.getDeployContext, lease),
		).rejects.toThrow(/Agent authentication required/);
		await expect(
			agent.query(api.applications.agent.getDeployContext, {
				...lease,
				leaseId: "stolen",
			}),
		).rejects.toThrow(/Lease lost/);

		const context = await agent.query(
			api.applications.agent.getDeployContext,
			lease,
		);
		expect(context).toMatchObject({
			mode: "deploy",
			target: { kind: "application", id: applicationId },
			sameHost: true,
			deploymentId,
			source: { type: "git", git: { url: gitSource.url, branch: "main" } },
			build: { type: "nixpacks", buildPath: "" },
			env: {
				env: "A=1\nB=${{project.X}}",
				buildSecrets: "TOKEN=secret",
				projectEnv: "X=2",
			},
			patches: [
				{
					filePath: "src/config.ts",
					type: "update",
					content: "export const x = 1;\n",
				},
			],
			deployTarget: {
				type: "ssh",
				host: "10.0.0.5",
				privateKey: "PRIVATE KEY",
			},
			rollback: null,
		});

		await agent.mutation(api.applications.agent.reportStarted, lease);
		expect(
			(await alice.query(api.applications.applications.get, { applicationId }))
				?.status,
		).toBe("running");
		await agent.mutation(api.applications.agent.reportDeployResult, {
			...lease,
			ok: true,
			imageRef: "app:latest",
			commit: { sha: "abc123", message: "Fix the header\n\nbody" },
		});
		expect(
			await alice.query(api.applications.applications.get, { applicationId }),
		).toMatchObject({ status: "done", lastImage: "app:latest" });
		const [deployment] = await alice.query(
			api.applications.deploy.listDeployments,
			{
				applicationId,
			},
		);
		expect(deployment).toMatchObject({
			title: "Fix the header",
			description: "Commit: abc123",
			imageRef: "app:latest",
			commit: { sha: "abc123" },
			status: "running",
		});
		expect(await scheduled(t)).toContain("platform/notifications:dispatch");

		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		await expect(
			agent.query(api.applications.agent.getDeployContext, lease),
		).rejects.toThrow(/Lease lost/);
		vi.useRealTimers();
	});

	test("start and stop report service status", async () => {
		const ctx = await seed();
		const applicationId = await createApp(ctx);
		await markDeployed(ctx.t, "applications", applicationId);
		await ctx.alice.mutation(api.applications.deploy.start, { applicationId });
		const lease = await claim(ctx.agent, "application.start");
		expect(
			await ctx.agent.query(api.applications.agent.getServiceContext, lease),
		).toMatchObject({ replicas: 1 });
		await expect(
			ctx.agent.query(api.applications.agent.getDeployContext, lease),
		).rejects.toThrow(/Not a/);
		await ctx.agent.mutation(api.applications.agent.reportServiceStatus, {
			...lease,
			status: "done",
		});
		expect(
			(
				await ctx.alice.query(api.applications.applications.get, {
					applicationId,
				})
			)?.status,
		).toBe("done");
	});
});

describe("deploy webhook", () => {
	const post = (
		t: TestConvex,
		token: string,
		body: unknown,
		headers: Record<string, string> = { "x-github-event": "push" },
	) =>
		t.fetch(`/api/deploy/${token}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});

	const tokenOf = async (t: TestConvex, applicationId: Id<"applications">) =>
		(await t.run((c) => c.db.get("applications", applicationId)))
			?.refreshToken ?? "";

	const push = (branch: string, files: string[]) => ({
		ref: `refs/heads/${branch}`,
		repository: { name: "web", owner: { login: "acme" } },
		head_commit: { id: "c0ffee", message: "Update src" },
		commits: [{ added: [], modified: files, removed: [] }],
	});

	test("git pushes deploy on branch and watch path matches", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: gitSource,
		});
		const token = await tokenOf(t, applicationId);

		const ok = await post(t, token, push("main", ["src/index.ts"]));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({
			message: "Application deployed successfully",
		});
		const [deployment] = await alice.query(
			api.applications.deploy.listDeployments,
			{
				applicationId,
			},
		);
		expect(deployment).toMatchObject({
			title: "Update src",
			description: "Hash: c0ffee",
			status: "queued",
		});

		const branch = await post(t, token, push("dev", ["src/index.ts"]));
		expect(branch.status).toBe(301);
		expect(await branch.json()).toEqual({ message: "Branch Not Match" });
		const paths = await post(t, token, push("main", ["docs/readme.md"]));
		expect(await paths.json()).toEqual({ message: "Watch Paths Not Match" });
		expect((await post(t, "nope", push("main", []))).status).toBe(404);
		const ping = await post(t, token, {}, { "x-github-event": "ping" });
		expect(ping.status).toBe(200);

		await alice.mutation(api.applications.applications.update, {
			applicationId,
			autoDeploy: false,
		});
		expect((await post(t, token, push("main", ["src/a.ts"]))).status).toBe(400);
		expect(
			(await jobsOf(t)).filter((j) => j.spec.kind === "application.deploy"),
		).toHaveLength(1);
	});

	test("image pushes deploy docker sources when name and tag match", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		await alice.action(api.applications.applications.saveDockerSource, {
			applicationId,
			image: "acme/web:latest",
		});
		const token = await tokenOf(t, applicationId);
		const hub = (name: string, tag: string) =>
			post(
				t,
				token,
				{ repository: { repo_name: name }, push_data: { tag, pusher: "ci" } },
				{ "user-agent": "Go-http-client/1.1" },
			);
		const ok = await hub("acme/web", "latest");
		expect(ok.status).toBe(200);
		expect((await hub("acme/web", "dev")).status).toBe(301);
		expect((await hub("acme/api", "latest")).status).toBe(301);
		const [deployment] = await alice.query(
			api.applications.deploy.listDeployments,
			{
				applicationId,
			},
		);
		expect(deployment?.title).toBe(
			"DockerHub image pushed: acme/web:latest by ci",
		);
		// Without image details (a plain curl), the configured image deploys.
		expect((await post(t, token, {}, {})).status).toBe(200);
	});
});

describe("GitHub App events and previews", () => {
	const seedGithub = async (t: TestConvex) =>
		await t.run(async (c) => {
			const gitProviderId = await c.db.insert("gitProviders", {
				organizationId: "org1",
				userId: "alice",
				name: "GitHub",
				providerType: "github",
				sharedWithOrganization: false,
				config: {
					type: "github",
					githubUrl: "https://github.com",
					installationId: "42",
				},
				githubInstallationId: "42",
				connected: true,
			});
			await c.db.insert("secrets", {
				organizationId: "org1",
				kind: "sources.gitProvider.githubWebhookSecret",
				ownerId: gitProviderId,
				...(await encryptSecret("hook-secret")),
			});
			return gitProviderId;
		});

	const hook = async (t: TestConvex, event: string, body: object) => {
		const raw = JSON.stringify({ installation: { id: 42 }, ...body });
		const response = await t.fetch("/webhooks/github", {
			method: "POST",
			headers: {
				"x-github-event": event,
				"x-hub-signature-256": `sha256=${await hmacSha256Hex("hook-secret", raw)}`,
				"content-type": "application/json",
			},
			body: raw,
		});
		return (await response.json()) as { triggered?: number; message: string };
	};

	const repository = { name: "web", owner: { login: "acme" } };

	const pullRequest = (action: string, id = 900, labels: string[] = []) => ({
		action,
		number: id - 899,
		repository,
		pull_request: {
			id,
			number: id - 899,
			title: "Add feature",
			html_url: `https://github.com/acme/web/pull/${id - 899}`,
			head: { ref: "feature", sha: "f00d" },
			base: { ref: "main" },
			user: { login: "dev" },
			labels: labels.map((name) => ({ name })),
		},
	});

	const githubApp = async () => {
		const ctx = await seed();
		const gitProviderId = await seedGithub(ctx.t);
		const applicationId = await createApp(ctx);
		await ctx.alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: {
				type: "github",
				gitProviderId,
				owner: "acme",
				repository: "web",
				branch: "main",
				buildPath: "/",
				submodules: false,
			},
		});
		return { ...ctx, gitProviderId, applicationId };
	};

	test("pushes and tags deploy matching applications", async () => {
		const { t, alice, applicationId } = await githubApp();
		const pushEvent = (ref: string, repo = repository) => ({
			ref,
			repository: repo,
			head_commit: { id: "abc", message: "ship it" },
			commits: [{ modified: ["src/a.ts"] }],
		});
		expect(await hook(t, "push", pushEvent("refs/heads/main"))).toMatchObject({
			triggered: 1,
		});
		expect(await hook(t, "push", pushEvent("refs/heads/dev"))).toMatchObject({
			triggered: 0,
		});
		expect(
			await hook(
				t,
				"push",
				pushEvent("refs/heads/main", { name: "api", owner: { login: "acme" } }),
			),
		).toMatchObject({ triggered: 0 });
		expect(await hook(t, "push", pushEvent("refs/tags/v1"))).toMatchObject({
			triggered: 0,
		});
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			triggerType: "tag",
		});
		expect(await hook(t, "push", pushEvent("refs/tags/v1"))).toMatchObject({
			triggered: 1,
		});
		const titles = (
			await alice.query(api.applications.deploy.listDeployments, {
				applicationId,
			})
		).map((d) => d.title);
		expect(titles).toEqual(["Tag created: v1", "ship it"]);
	});

	test("pull requests create previews with a generated domain and are removed on close", async () => {
		// Scheduled actions (GitHub comments) stay queued instead of running.
		vi.useFakeTimers();
		const ctx = await githubApp();
		const { t, alice, applicationId, gitProviderId } = ctx;
		expect(await hook(t, "pull_request", pullRequest("opened"))).toMatchObject({
			triggered: 0,
		});
		await alice.mutation(api.applications.applications.savePreviewSettings, {
			applicationId,
			enabled: true,
			limit: 1,
			requireCollaboratorPermissions: false,
		});
		expect(await hook(t, "pull_request", pullRequest("opened"))).toMatchObject({
			triggered: 1,
		});
		expect(await scheduled(t)).toContain(
			"applications/previewActions:handlePullRequest",
		);

		// What the scheduled action does once the author is cleared.
		const args = {
			organizationId: "org1",
			gitProviderId,
			applicationIds: [applicationId],
			owner: "acme",
			repository: "web",
			create: true,
			pullRequest: {
				id: "900",
				number: 1,
				url: "https://github.com/acme/web/pull/1",
				title: "Add feature",
				branch: "feature",
				headSha: "f00d",
				labels: [],
				author: "dev",
			},
		};
		const [previewId] = await t.action(
			internal.applications.previewActions.handlePullRequest,
			args,
		);
		if (!previewId) throw new Error("expected a preview");
		const preview = await alice.query(api.applications.previews.get, {
			previewId,
		});
		expect(preview?.appName).toMatch(/^preview-app-.*-[a-z0-9]{6}$/);
		expect(preview?.host).toMatch(/^preview-app-.*-10-0-0-5\.sslip\.io$/);
		const routing = await t.run((c) =>
			c.db
				.query("routingOwners")
				.withIndex("by_owner", (q) =>
					q.eq("owner.kind", "preview").eq("owner.id", previewId),
				)
				.unique(),
		);
		expect(routing).toMatchObject({
			appName: preview?.appName,
			serverId: ctx.serverId,
			parent: { kind: "application", id: applicationId },
		});
		const domains = await t.run((c) => c.db.query("domains").collect());
		expect(domains).toMatchObject([
			{
				owner: { kind: "preview", id: previewId },
				host: preview?.host,
				port: 3000,
			},
		]);
		const previewJobs = (await jobsOf(t)).filter(
			(j) => j.spec.kind === "application.previewDeploy",
		);
		expect(previewJobs).toMatchObject([
			{
				group: `preview:${previewId}`,
				partition: ctx.serverId,
				usesBuildSlot: true,
			},
		]);

		// A new push to the same PR redeploys; the limit blocks a second PR.
		await t.action(
			internal.applications.previewActions.handlePullRequest,
			args,
		);
		const second = await t.action(
			internal.applications.previewActions.handlePullRequest,
			{ ...args, pullRequest: { ...args.pullRequest, id: "901", number: 2 } },
		);
		expect(second).toEqual([]);
		expect(
			await alice.query(api.applications.previews.listByApplication, {
				applicationId,
			}),
		).toHaveLength(1);
		expect(
			(await jobsOf(t)).filter(
				(j) => j.spec.kind === "application.previewDeploy",
			),
		).toHaveLength(2);

		// The agent context builds the PR branch with preview env.
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			previewEnv: "MODE=preview",
		});
		const lease = await claim(ctx.agent, "application.previewDeploy");
		const context = await ctx.agent.query(
			api.applications.agent.getDeployContext,
			lease,
		);
		expect(context).toMatchObject({
			appName: preview?.appName,
			target: { kind: "preview", id: previewId },
			source: { git: { branch: "feature" } },
			env: { env: `MODE=preview\nPANARA_CLOUD_DEPLOY_URL=${preview?.host}` },
			rollback: null,
		});
		await ctx.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});

		expect(await hook(t, "pull_request", pullRequest("closed"))).toMatchObject({
			triggered: 1,
		});
		expect(
			await alice.query(api.applications.previews.listByApplication, {
				applicationId,
			}),
		).toEqual([]);
		expect(
			(await jobsOf(t)).filter(
				(j) => j.spec.kind === "application.previewRemove",
			),
		).toMatchObject([
			{ spec: { appName: preview?.appName }, partition: ctx.serverId },
		]);
		expect(
			await t.run((c) =>
				c.db
					.query("routingOwners")
					.withIndex("by_owner", (q) =>
						q.eq("owner.kind", "preview").eq("owner.id", previewId),
					)
					.unique(),
			),
		).toBeNull();
		vi.useRealTimers();
	});

	test("label filters skip pull requests without a matching label", async () => {
		const ctx = await githubApp();
		await ctx.alice.mutation(
			api.applications.applications.savePreviewSettings,
			{
				applicationId: ctx.applicationId,
				enabled: true,
				labels: ["preview"],
				requireCollaboratorPermissions: false,
			},
		);
		const run = (labels: string[]) =>
			ctx.t.mutation(internal.applications.gitEvents.deployPreviews, {
				organizationId: "org1",
				applicationIds: [ctx.applicationId],
				create: true,
				pullRequest: {
					id: "77",
					number: 7,
					url: "u",
					title: "t",
					branch: "feature",
					labels,
				},
			});
		expect(await run(["bug"])).toEqual([]);
		expect(await run(["preview"])).toHaveLength(1);
	});
});

describe("rollbacks", () => {
	test("keeps the configured number of images and redeploys a kept one", async () => {
		const ctx = await seed();
		const { t, alice, agent } = ctx;
		const applicationId = await createApp(ctx);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: gitSource,
		});
		await alice.mutation(api.applications.applications.saveRollbackSettings, {
			applicationId,
			enabled: true,
			keep: 2,
		});
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "SECRET=v1",
		});
		const prunes: string[][] = [];
		for (const version of [1, 2, 3]) {
			await alice.mutation(api.applications.deploy.deploy, { applicationId });
			const lease = await claim(agent, "application.deploy");
			const context = await agent.query(
				api.applications.agent.getDeployContext,
				lease,
			);
			expect(context?.rollback).toEqual({ keep: 2, nextVersion: version });
			const { prune } = await agent.action(
				api.applications.agent.recordRollback,
				{
					...lease,
					version,
					image: `app:v${version}`,
					localTag: `app:v${version}`,
				},
			);
			prunes.push(prune);
			await agent.mutation(api.agent.complete, {
				...lease,
				result: { kind: "none" },
			});
		}
		expect(prunes).toEqual([[], [], ["app:v1"]]);
		const rows = await alice.query(api.applications.rollbacks.list, {
			applicationId,
		});
		expect(rows.map((r) => r.version)).toEqual([3, 2]);
		const secrets = await t.run((c) =>
			c.db
				.query("secrets")
				.collect()
				.then((all) =>
					all.filter((s) => s.kind === "application.rollbackContext"),
				),
		);
		expect(secrets).toHaveLength(2);
		// Snapshots are encrypted, never stored as plaintext.
		expect(JSON.stringify(secrets)).not.toContain("SECRET=v1");

		const mallory = asUser(t, "mallory");
		const v2 = rows[1]?._id as Id<"applicationRollbacks">;
		await expect(
			mallory.mutation(api.applications.rollbacks.rollback, { rollbackId: v2 }),
		).rejects.toThrow(/access to this service/);
		await alice.mutation(api.applications.rollbacks.rollback, {
			rollbackId: v2,
		});
		const lease = await claim(agent, "application.rollback");
		const context = await agent.query(
			api.applications.agent.getRollbackContext,
			lease,
		);
		expect(context).toMatchObject({
			version: 2,
			image: "app:v2",
			snapshot: { env: "SECRET=v1", service: { replicas: 1 } },
		});
		const [latest] = await alice.query(
			api.applications.deploy.listDeployments,
			{
				applicationId,
			},
		);
		expect(latest?.title).toBe("Rollback to v2");
		// Version 2 restores what its deploy applied: everything up to its start.
		const started = await t.run(async (c) => {
			const deployment = await c.db.get(
				"deployments",
				rows[1]?.deploymentId as Id<"deployments">,
			);
			return (await c.db.get("jobs", deployment?.jobId as Id<"jobs">))
				?.startedAt;
		});
		const appliedAt = { deploy: started, build: started, spec: started };
		expect(rows[1]?.appliedAt).toEqual(appliedAt);
		const rollbackJob = await t.run((c) =>
			c.db.get("jobs", lease.jobId as Id<"jobs">),
		);
		expect(rollbackJob?.spec).toMatchObject({ appliedAt });
	});
});

describe("removal", () => {
	test("deleting an application cascades and cleans up its hosts", async () => {
		vi.useFakeTimers();
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		const other = await createApp(ctx);
		const owner = { kind: "application" as const, id: applicationId };
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: gitSource,
		});
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "A=1",
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await alice.mutation(api.applications.patches.save, {
			owner,
			filePath: "a.txt",
			content: "x",
		});
		const { jobId: queuedDeploy } = await alice.mutation(
			api.applications.deploy.deploy,
			{ applicationId },
		);
		const app = await t.run((c) => c.db.get("applications", applicationId));
		await t.run(async (c) => {
			await c.db.insert("applicationPreviews", {
				organizationId: "org1",
				applicationId,
				appName: "preview-x-abcdef",
				host: "preview-x.example.com",
				pullRequest: { id: "1", number: 1, url: "u", title: "t", branch: "b" },
				status: "done",
			});
			await c.db.insert("applicationRollbacks", {
				organizationId: "org1",
				applicationId,
				version: 1,
				image: "app:v1",
				localTag: "app:v1",
			});
		});

		await alice.mutation(api.applications.applications.remove, {
			applicationId,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const remaining = await t.run(async (c) => ({
			apps: (await c.db.query("applications").collect()).map((a) => a._id),
			previews: await c.db.query("applicationPreviews").collect(),
			rollbacks: await c.db.query("applicationRollbacks").collect(),
			patches: await c.db.query("patches").collect(),
			patchContents: await c.db.query("patchContents").collect(),
			mounts: await c.db.query("mounts").collect(),
			deployments: await c.db.query("deployments").collect(),
			secrets: (await c.db.query("secrets").collect()).filter((s) =>
				s.kind.startsWith("application."),
			),
			routing: (await c.db.query("routingOwners").collect()).map(
				(r) => r.owner.id,
			),
		}));
		expect(remaining).toEqual({
			apps: [other],
			previews: [],
			rollbacks: [],
			patches: [],
			patchContents: [],
			mounts: [],
			deployments: [],
			secrets: [],
			routing: [other],
		});
		const jobs = await jobsOf(t);
		expect(jobs.find((j) => j._id === queuedDeploy)?.status).toBe("cancelled");
		expect(
			jobs
				.filter(
					(j) =>
						j.spec.kind.endsWith("Remove") || j.spec.kind.endsWith(".remove"),
				)
				.map((j) => ({ kind: j.spec.kind, partition: j.partition })),
		).toEqual(
			expect.arrayContaining([
				{ kind: "application.remove", partition: ctx.serverId },
				{ kind: "infra.routingRemove", partition: ctx.serverId },
				{ kind: "application.previewRemove", partition: ctx.serverId },
			]),
		);
		expect(
			jobs.find((j) => j.spec.kind === "application.remove")?.spec,
		).toEqual({
			kind: "application.remove",
			appName: app?.appName,
			removeService: true,
		});
		vi.useRealTimers();
	});
});

describe("removal with volumes", () => {
	const removeSpecs = async (t: TestConvex) =>
		(await jobsOf(t)).flatMap((job) =>
			job.spec.kind === "application.remove" ? [job.spec] : [],
		);

	test("offers the application's own volumes, never reserved ones or bind mounts; the job decides the shared ones", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		const sibling = await createApp(ctx);
		const mounts = [
			{ type: "volume", volumeName: "uploads", mountPath: "/uploads" },
			{ type: "volume", volumeName: "shared", mountPath: "/shared" },
			{ type: "volume", volumeName: "panara-cloud-data", mountPath: "/panel" },
			{ type: "bind", hostPath: "/srv/files", mountPath: "/files" },
		] as const;
		for (const mount of mounts) {
			await alice.mutation(api.applications.mounts.create, {
				applicationId,
				mount,
			});
		}
		await alice.mutation(api.applications.mounts.create, {
			applicationId: sibling,
			mount: { type: "volume", volumeName: "shared", mountPath: "/shared" },
		});
		const app = await t.run((c) => c.db.get("applications", applicationId));
		const other = await t.run((c) => c.db.get("applications", sibling));
		const target = (id: string) => ({ kind: "application" as const, id });

		expect(
			await alice.query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets: [target(applicationId)],
			}),
		).toEqual([
			{
				appName: app?.appName,
				volumes: [
					{ name: "uploads", keptBecause: null },
					{ name: "shared", keptBecause: "still used by Web (application)" },
				],
			},
		]);
		// Selected together, the volume they share goes with them.
		expect(
			await alice.query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets: [target(applicationId), target(sibling)],
			}),
		).toEqual([
			{
				appName: app?.appName,
				volumes: [
					{ name: "uploads", keptBecause: null },
					{ name: "shared", keptBecause: null },
				],
			},
			{
				appName: other?.appName,
				volumes: [{ name: "shared", keptBecause: null }],
			},
		]);

		// The shared volume is a candidate too: whether the sibling still uses
		// it is decided when the job runs (and reported if it is kept).
		const jobId = await alice.mutation(api.applications.applications.remove, {
			applicationId,
			deleteVolumes: true,
			deletingTogether: [other?.appName ?? ""],
		});
		expect(await removeSpecs(t)).toEqual([
			{
				kind: "application.remove",
				appName: app?.appName,
				removeService: true,
				volumeNames: ["uploads", "shared"],
				deletingTogether: [other?.appName],
			},
		]);
		expect((await jobsOf(t)).map((job) => job._id)).toContain(jobId);

		await alice.mutation(api.applications.applications.remove, {
			applicationId: sibling,
			deleteVolumes: true,
		});
		expect((await removeSpecs(t))[1]).toEqual({
			kind: "application.remove",
			appName: other?.appName,
			removeService: true,
			volumeNames: ["shared"],
		});
	});

	test("keeps the volumes unless asked, and never sends them to a build server", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const buildServerId = await createServer(t, "org1", "10.0.0.9");
		const kept = await createApp(ctx);
		const built = await createApp(ctx);
		for (const applicationId of [kept, built]) {
			await alice.mutation(api.applications.mounts.create, {
				applicationId,
				mount: {
					type: "volume",
					volumeName: `data-${applicationId}`,
					mountPath: "/data",
				},
			});
		}
		await t.run((c) => c.db.patch("applications", built, { buildServerId }));

		await alice.mutation(api.applications.applications.remove, {
			applicationId: kept,
		});
		expect(await removeSpecs(t)).toEqual([
			expect.not.objectContaining({ volumeNames: expect.anything() }),
		]);

		await alice.mutation(api.applications.applications.remove, {
			applicationId: built,
			deleteVolumes: true,
		});
		const jobs = (await jobsOf(t)).filter(
			(job) => job.spec.kind === "application.remove",
		);
		expect(
			jobs.slice(1).map((job) => ({
				partition: job.partition,
				volumes:
					job.spec.kind === "application.remove"
						? (job.spec.volumeNames ?? null)
						: null,
			})),
		).toEqual(
			expect.arrayContaining([
				{ partition: ctx.serverId, volumes: [`data-${built}`] },
				{ partition: buildServerId, volumes: null },
			]),
		);
	});

	test("reports no deletable volumes for services out of reach", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "uploads", mountPath: "/uploads" },
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId: ctx.environmentId,
			name: "Stack",
			serverId: ctx.serverId,
		});
		const targets = [
			{ kind: "application" as const, id: applicationId },
			{ kind: "compose" as const, id: composeId },
		];
		expect(
			await alice.query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets,
			}),
		).toEqual([
			{
				appName: expect.any(String),
				volumes: [{ name: "uploads", keptBecause: null }],
			},
			// No file in the panel yet: nothing it would create.
			{ appName: expect.any(String), volumes: [] },
		]);
		// A member without these services learns nothing about them.
		expect(
			await asUser(t, "mallory").query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets,
			}),
		).toEqual([
			{ appName: null, volumes: [] },
			{ appName: null, volumes: [] },
		]);
		await expect(
			asUser(t, "eve").query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets,
			}),
		).rejects.toThrow();
	});
});

describe("patches and mounts", () => {
	test("are authorized through the owning service", async () => {
		const ctx = await seed();
		const { t, alice } = ctx;
		const applicationId = await createApp(ctx);
		const owner = { kind: "application" as const, id: applicationId };
		const patchId = await alice.mutation(api.applications.patches.save, {
			owner,
			filePath: "./src/app.ts",
			content: "a",
		});
		expect(
			await alice.query(api.applications.patches.get, { patchId }),
		).toMatchObject({
			filePath: "src/app.ts",
			content: "a\n",
			type: "update",
			enabled: true,
		});
		await alice.mutation(api.applications.patches.markForDeletion, {
			owner,
			filePath: "src/app.ts",
		});
		await alice.mutation(api.applications.patches.update, {
			patchId,
			enabled: false,
		});
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.applications.patches.list, { owner }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		expect(
			await mallory.query(api.applications.patches.list, { owner }),
		).toMatchObject([
			{ filePath: "src/app.ts", type: "delete", enabled: false },
		]);
		await expect(
			mallory.mutation(api.applications.patches.save, {
				owner,
				filePath: "b",
				content: "",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			alice.mutation(api.applications.patches.save, {
				owner,
				filePath: "../etc/passwd",
				content: "",
			}),
		).rejects.toThrow(/inside the repository/);
		await expect(
			asUser(t, "eve").query(api.applications.patches.list, { owner }),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.query(api.applications.patches.list, {
				owner: { kind: "compose", id: "missing" },
			}),
		).rejects.toThrow(/Service not found/);

		const mountId = await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: {
				type: "file",
				filePath: "conf/app.ini",
				content: "k=v",
				mountPath: "/app.ini",
			},
		});
		await expect(
			alice.mutation(api.applications.mounts.create, {
				applicationId,
				mount: { type: "volume", volumeName: "v", mountPath: "/app.ini" },
			}),
		).rejects.toThrow(/already mounted/);
		expect(
			await mallory.query(api.applications.mounts.list, { applicationId }),
		).toHaveLength(1);
		await expect(
			asUser(t, "eve").mutation(api.applications.mounts.remove, { mountId }),
		).rejects.toThrow(/Not a member/);
		await alice.mutation(api.applications.mounts.update, {
			mountId,
			mount: {
				type: "file",
				filePath: "conf/app.ini",
				content: "k=w",
				mountPath: "/app.ini",
			},
		});
		expect(
			await alice.query(api.applications.mounts.list, { applicationId }),
		).toMatchObject([{ content: "k=w" }]);
	});
});
