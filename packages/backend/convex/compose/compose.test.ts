import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { GitEvent } from "../tables/sources";
import {
	addAgent,
	addMember,
	addServer,
	asAgent,
	asUser,
	grantMember,
	markDeployed,
	setup,
	type TestConvex,
} from "../test.setup";

const COMPOSE_FILE = `services:
  web:
    image: nginx:alpine
`;

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const agentId = await addAgent(t);
	return {
		t,
		alice,
		bob: asUser(t, "bob"),
		mallory: asUser(t, "mallory"),
		agent: asAgent(t, agentId),
		projectId,
		environmentId,
	};
};

const grantBob = (
	s: Awaited<ReturnType<typeof seed>>,
	grants: Parameters<typeof grantMember>[3],
) => grantMember(s.t, "org1", "bob", grants);

const createCompose = (
	s: Awaited<ReturnType<typeof seed>>,
	fields: { composeType?: "docker-compose" | "stack" } = {},
) =>
	s.alice.mutation(api.compose.crud.create, {
		environmentId: s.environmentId,
		name: "Web stack",
		composeFile: COMPOSE_FILE,
		...fields,
	});

const addGithubProvider = (t: TestConvex, organizationId = "org1") =>
	t.run((ctx) =>
		ctx.db.insert("gitProviders", {
			organizationId,
			userId: "alice",
			name: "GitHub",
			providerType: "github",
			sharedWithOrganization: true,
			config: { type: "github", githubUrl: "https://github.com" },
			connected: true,
		}),
	);

const useGithubSource = async (
	s: Awaited<ReturnType<typeof seed>>,
	composeId: Id<"compose">,
	gitProviderId: Id<"gitProviders">,
	extra: { watchPaths?: string[] } = {},
) =>
	s.alice.mutation(api.compose.crud.setSource, {
		composeId,
		source: {
			type: "git",
			gitSource: {
				type: "github",
				gitProviderId,
				owner: "acme",
				repository: "web",
				branch: "main",
				buildPath: "/",
				submodules: false,
				...extra,
			},
			composePath: "./deploy/docker-compose.yml",
		},
	});

const claim = async (s: Awaited<ReturnType<typeof seed>>) => {
	const job = await s.agent.mutation(api.agent.claimNext, {});
	if (!job) throw new Error("expected a job");
	return { jobId: job.jobId, leaseId: job.leaseId, spec: job.spec };
};

const queuedJobs = (t: TestConvex) =>
	t.run((ctx) =>
		ctx.db
			.query("jobs")
			.withIndex("by_status", (q) => q.eq("status", "queued"))
			.collect(),
	);

const pushEvent = (fields: Partial<GitEvent> = {}): GitEvent => ({
	provider: "github",
	kind: "push",
	repo: { owner: "acme", name: "web", fullName: "acme/web" },
	branch: "main",
	commitSha: "abc123",
	commitMessage: "Ship it",
	changedFiles: ["deploy/docker-compose.yml"],
	skipCi: false,
	...fields,
});

describe("compose CRUD and authorization", () => {
	test("members see granted services without secrets; other orgs see nothing", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const compose = await s.alice.query(api.compose.crud.get, { composeId });
		expect(compose?.appName).toMatch(/^web-stack-[a-z0-9]{6}$/);
		expect(compose?.refreshToken).toMatch(/^[A-Za-z0-9]{24}$/);
		expect(compose?.status).toBe("idle");

		expect(
			await s.bob.query(api.compose.crud.list, {
				environmentId: s.environmentId,
			}),
		).toHaveLength(0);
		await expect(
			s.bob.query(api.compose.crud.get, { composeId }),
		).rejects.toThrow(/access to this service/);
		await expect(
			s.bob.mutation(api.compose.deploy.deploy, { composeId }),
		).rejects.toThrow(/access to this service/);
		await grantBob(s, { services: [composeId] });

		const asMember = await s.bob.query(api.compose.crud.get, { composeId });
		expect(asMember?.refreshToken).toBeNull();
		const listed = await s.bob.query(api.compose.crud.list, {
			environmentId: s.environmentId,
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]?.refreshToken).toBeNull();
		expect(JSON.stringify(listed)).not.toContain("nginx:alpine");
		expect(listed[0]).not.toHaveProperty("composeFile");
		expect(await s.bob.query(api.compose.crud.getFile, { composeId })).toBe(
			COMPOSE_FILE,
		);

		await expect(
			s.bob.mutation(api.compose.crud.create, {
				environmentId: s.environmentId,
				name: "nope",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			s.bob.mutation(api.compose.crud.update, { composeId, name: "x" }),
		).rejects.toThrow(/service\.create/);
		await grantBob(s, { flags: { canCreateServices: true } });
		await expect(
			s.bob.mutation(api.compose.crud.create, {
				environmentId: s.environmentId,
				name: "nope",
			}),
		).rejects.toThrow(/access to this project/);
		await s.bob.mutation(api.compose.crud.update, { composeId, name: "x" });
		await grantBob(s, { projects: [s.projectId] });
		await expect(
			s.bob.mutation(api.compose.crud.create, {
				environmentId: s.environmentId,
				name: "mine",
			}),
		).rejects.toThrow(/Only the instance administrator/);
		const own = await s.bob.mutation(api.compose.crud.create, {
			environmentId: s.environmentId,
			name: "mine",
			serverId: await addServer(s.t, "org1"),
		});
		expect(
			await s.bob.query(api.compose.crud.list, {
				environmentId: s.environmentId,
			}),
		).toHaveLength(2);
		expect(
			(await s.bob.query(api.compose.crud.get, { composeId: own }))?.name,
		).toBe("mine");
		await expect(
			s.mallory.query(api.compose.crud.get, { composeId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.mallory.query(api.compose.crud.getFile, { composeId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.mallory.mutation(api.compose.deploy.deploy, { composeId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.mallory.mutation(api.compose.crud.create, {
				environmentId: s.environmentId,
				name: "x",
			}),
		).rejects.toThrow(/Not a member/);

		const routing = await s.t.run((ctx) =>
			ctx.db
				.query("routingOwners")
				.withIndex("by_owner", (q) =>
					q.eq("owner.kind", "compose").eq("owner.id", composeId),
				)
				.unique(),
		);
		expect(routing?.composeType).toBe("docker-compose");
		expect(routing?.appName).toBe(compose?.appName);
	});

	test("env is encrypted, scoped to granted members, and updates validate input", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		await s.alice.action(api.compose.crud.setEnv, {
			composeId,
			env: "TOKEN=s3cret",
			createEnvFile: false,
		});
		expect(await s.alice.query(api.compose.crud.getEnv, { composeId })).toBe(
			"TOKEN=s3cret",
		);
		await expect(
			s.bob.query(api.compose.crud.getEnv, { composeId }),
		).rejects.toThrow(/access to this service/);
		await expect(
			s.bob.action(api.compose.crud.setEnv, { composeId, env: "X=1" }),
		).rejects.toThrow(/access to this service/);
		const secret = await s.t.run((ctx) =>
			ctx.db
				.query("secrets")
				.withIndex("by_kind_and_ownerId", (q) =>
					q.eq("kind", "compose.env").eq("ownerId", composeId),
				)
				.unique(),
		);
		expect(secret?.ciphertext).not.toContain("s3cret");

		await expect(
			s.alice.mutation(api.compose.crud.update, {
				composeId,
				command: "compose up -d; rm -rf /",
			}),
		).rejects.toThrow(/shell control/);
		await expect(
			s.alice.mutation(api.compose.crud.update, {
				composeId,
				composePath: "../etc/passwd",
			}),
		).rejects.toThrow(/Invalid compose path/);
		await expect(
			s.alice.mutation(api.compose.crud.update, { composeId, suffix: "a b" }),
		).rejects.toThrow(/suffix/i);
		await s.alice.mutation(api.compose.crud.update, {
			composeId,
			randomize: true,
			suffix: "blue",
			composeType: "stack",
			command: "compose -p x up -d && docker compose -p x ps",
		});
		const routing = await s.t.run((ctx) =>
			ctx.db.query("routingOwners").first(),
		);
		expect(routing?.composeType).toBe("stack");
	});

	test("git sources must belong to the organization", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const foreign = await addGithubProvider(s.t, "org2");
		await expect(useGithubSource(s, composeId, foreign)).rejects.toThrow(
			/Git provider not found/,
		);
		const own = await addGithubProvider(s.t);
		await useGithubSource(s, composeId, own);
		const compose = await s.alice.query(api.compose.crud.get, { composeId });
		expect(compose?.sourceType).toBe("git");
		expect(compose?.gitProviderId).toBe(own);
		expect(compose?.composePath).toBe("./deploy/docker-compose.yml");
	});

	test("delete cascades mounts, routing, env, file, schedules and queues teardown", async () => {
		vi.useFakeTimers();
		const s = await seed();
		const composeId = await createCompose(s);
		const appName = (await s.alice.query(api.compose.crud.get, { composeId }))
			?.appName;
		await s.alice.action(api.compose.crud.setEnv, { composeId, env: "A=1" });
		await s.alice.mutation(api.compose.mounts.add, {
			composeId,
			mount: {
				type: "file",
				filePath: "conf/app.ini",
				content: "x",
				mountPath: "/conf",
			},
		});
		await s.alice.mutation(api.infra.domains.create, {
			owner: { kind: "compose", id: composeId },
			host: "shop.example.com",
			https: false,
			certificateType: "none",
			serviceName: "web",
			port: 80,
		});
		await s.alice.mutation(api.compose.deploy.deploy, { composeId });
		await grantBob(s, { services: [composeId] });
		await expect(
			s.bob.mutation(api.compose.crud.remove, { composeId }),
		).rejects.toThrow(/service\.delete/);

		await s.alice.mutation(api.compose.crud.remove, {
			composeId,
			deleteVolumes: true,
		});
		await s.t.finishAllScheduledFunctions(vi.runAllTimers);

		const state = await s.t.run(async (ctx) => ({
			compose: await ctx.db.get("compose", composeId),
			files: await ctx.db.query("composeFiles").collect(),
			secrets: await ctx.db.query("secrets").collect(),
			mounts: await ctx.db.query("mounts").collect(),
			domains: await ctx.db.query("domains").collect(),
			routing: await ctx.db.query("routingOwners").collect(),
			deployments: await ctx.db.query("deployments").collect(),
			jobs: await ctx.db.query("jobs").collect(),
		}));
		expect(state.compose).toBeNull();
		expect(state.files).toEqual([]);
		expect(state.secrets.filter((x) => x.kind === "compose.env")).toEqual([]);
		expect(state.mounts).toEqual([]);
		expect(state.domains).toEqual([]);
		expect(state.routing).toEqual([]);
		expect(state.deployments).toEqual([]);
		const deployJob = state.jobs.find((j) => j.spec.kind === "compose.deploy");
		expect(deployJob?.status).toBe("cancelled");
		const removeJob = state.jobs.find((j) => j.spec.kind === "compose.remove");
		expect(removeJob?.spec).toEqual({
			kind: "compose.remove",
			appName,
			composeType: "docker-compose",
			deleteVolumes: true,
		});
		expect(removeJob?.status).toBe("queued");
		vi.useRealTimers();
	});

	test("deleting a compose service stops its running deploy", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const { jobId: deployJobId } = await s.alice.mutation(
			api.compose.deploy.deploy,
			{ composeId },
		);
		expect((await claim(s)).jobId).toBe(deployJobId);
		await markDeployed(s.t, "compose", composeId);
		const stopJobId = await s.alice.mutation(api.compose.deploy.stop, {
			composeId,
		});

		await s.alice.mutation(api.compose.crud.remove, { composeId });

		const jobs = await s.t.run((ctx) => ctx.db.query("jobs").collect());
		expect(jobs.find((job) => job._id === deployJobId)).toMatchObject({
			status: "running",
			cancelRequested: true,
		});
		expect(jobs.find((job) => job._id === stopJobId)?.status).toBe("cancelled");
		expect(jobs.find((job) => job.spec.kind === "compose.remove")?.status).toBe(
			"queued",
		);
		// The removal shares the group, so it waits for the build to stop.
		expect(await s.agent.mutation(api.agent.claimNext, {})).toBeNull();
	});

	test("mount wrappers authorize against the compose", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const mountId = await s.alice.mutation(api.compose.mounts.add, {
			composeId,
			mount: {
				type: "file",
				filePath: "a.conf",
				content: "1",
				mountPath: "/a.conf",
			},
		});
		await expect(
			s.bob.mutation(api.compose.mounts.remove, { mountId }),
		).rejects.toThrow(/access to this service/);
		await grantBob(s, { services: [composeId] });
		expect(
			await s.bob.query(api.compose.mounts.list, { composeId }),
		).toHaveLength(1);
		await expect(
			s.mallory.query(api.compose.mounts.list, { composeId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.mallory.mutation(api.compose.mounts.update, {
				mountId,
				mount: {
					type: "file",
					filePath: "a.conf",
					content: "2",
					mountPath: "/a.conf",
				},
			}),
		).rejects.toThrow(/Not a member/);
		await s.bob.mutation(api.compose.mounts.remove, { mountId });
		expect(
			await s.alice.query(api.compose.mounts.list, { composeId }),
		).toHaveLength(0);
	});
});

describe("compose jobs", () => {
	test("deploy queues a build-slot job and a deployment; the agent needs the lease", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		await s.alice.action(api.compose.crud.setEnv, {
			composeId,
			env: "TOKEN=${{project.SHARED}}",
		});
		await s.alice.action(api.projects.setEnv, {
			projectId: s.projectId,
			env: "SHARED=yes",
		});
		await s.alice.mutation(api.infra.domains.create, {
			owner: { kind: "compose", id: composeId },
			host: "shop.example.com",
			https: true,
			certificateType: "letsencrypt",
			serviceName: "web",
			port: 80,
		});
		await expect(
			s.bob.mutation(api.compose.deploy.deploy, { composeId }),
		).rejects.toThrow(/access to this service/);
		await grantBob(s, { services: [composeId] });
		const { jobId } = await s.alice.mutation(api.compose.deploy.deploy, {
			composeId,
			title: "First",
		});
		const job = await s.t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.usesBuildSlot).toBe(true);
		expect(job?.group).toBe(`compose:${composeId}`);
		expect(job?.partition).toBe("local");

		const claimed = await claim(s);
		expect(claimed.spec).toEqual({
			kind: "compose.deploy",
			composeId,
			trusted: true,
		});
		await expect(
			s.agent.query(api.compose.agent.getContext, {
				jobId,
				leaseId: "wrong",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			s.alice.query(api.compose.agent.getContext, {
				jobId,
				leaseId: claimed.leaseId,
			}),
		).rejects.toThrow(/Agent authentication/);

		const context = await s.agent.query(api.compose.agent.getContext, {
			jobId,
			leaseId: claimed.leaseId,
		});
		expect(context?.composeFile).toBe(COMPOSE_FILE);
		expect(context?.env).toBe("TOKEN=${{project.SHARED}}");
		expect(context?.projectEnv).toBe("SHARED=yes");
		expect(context?.projectName).toBe("Shop");
		expect(context?.domains).toHaveLength(1);
		expect(context?.domains[0]).toMatchObject({
			host: "shop.example.com",
			serviceName: "web",
			https: true,
		});

		await s.agent.mutation(api.compose.agent.report, {
			jobId,
			leaseId: claimed.leaseId,
			status: "running",
		});
		expect(
			(await s.alice.query(api.compose.crud.get, { composeId }))?.status,
		).toBe("running");
		await s.agent.mutation(api.compose.agent.report, {
			jobId,
			leaseId: claimed.leaseId,
			status: "done",
			services: ["web"],
			commit: { sha: "abc", message: "Fix\n\nbody" },
		});
		const after = await s.alice.query(api.compose.crud.get, { composeId });
		expect(after?.status).toBe("done");
		expect(after?.services).toEqual(["web"]);
		const deployments = await s.bob.query(api.compose.deploy.listDeployments, {
			composeId,
		});
		expect(deployments[0]).toMatchObject({
			title: "Fix",
			commit: { sha: "abc" },
		});
	});

	test("load services and convert record results on an op", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const { opId } = await s.alice.mutation(api.compose.deploy.convert, {
			composeId,
		});
		await expect(
			s.mallory.query(api.compose.deploy.getOp, { opId }),
		).rejects.toThrow(/Not a member/);
		const { jobId, leaseId, spec } = await claim(s);
		expect(spec).toMatchObject({ kind: "compose.convert", opId, fetch: false });
		await s.agent.mutation(api.compose.agent.reportOp, {
			jobId,
			leaseId,
			result: "services: {}\n",
			services: ["web"],
		});
		const op = await s.alice.query(api.compose.deploy.getOp, { opId });
		expect(op?.result).toBe("services: {}\n");
		expect(op?.completedAt).toBeTypeOf("number");
		expect(
			(await s.alice.query(api.compose.crud.get, { composeId }))?.services,
		).toEqual(["web"]);
	});

	test("default command mirrors what the agent runs", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const compose = await s.alice.query(api.compose.crud.get, { composeId });
		await grantBob(s, {
			services: [composeId],
			flags: { canCreateServices: true },
		});
		expect(
			await s.bob.query(api.compose.deploy.defaultCommand, { composeId }),
		).toBe(
			`docker compose -p ${compose?.appName} --env-file .env -f docker-compose.yml up -d --build --remove-orphans`,
		);
	});

	test("a custom command written like the default is saved without its docker", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const shown = await s.alice.query(api.compose.deploy.defaultCommand, {
			composeId,
		});
		// The default plus one flag, typed as it is shown.
		await s.alice.mutation(api.compose.crud.update, {
			composeId,
			command: shown.replace("up -d", "up -d --wait"),
		});
		const saved = (await s.alice.query(api.compose.crud.get, { composeId }))
			?.command;
		expect(saved).toBe(shown.replace("up -d", "up -d --wait").slice(7));
		expect(saved?.startsWith("compose -p ")).toBe(true);
		// What is shown afterwards is what the agent runs: one docker.
		expect(
			await s.alice.query(api.compose.deploy.defaultCommand, { composeId }),
		).toBe(`docker ${saved}`);
		// A command stored before this, with the word, is shown the same way.
		await s.t.run((ctx) =>
			ctx.db.patch("compose", composeId, { command: `docker ${saved}` }),
		);
		expect(
			await s.alice.query(api.compose.deploy.defaultCommand, { composeId }),
		).toBe(`docker ${saved}`);
	});
});

describe("webhooks", () => {
	test("POST /api/deploy/compose/:refreshToken deploys raw composes", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const token = (await s.alice.query(api.compose.crud.get, { composeId }))
			?.refreshToken;
		const post = (path: string, body = "{}", headers = {}) =>
			s.t.fetch(path, { method: "POST", body, headers });

		expect((await post("/api/deploy/compose/unknown-token-1")).status).toBe(
			404,
		);
		const ping = await post(`/api/deploy/compose/${token}`, "{}", {
			"x-github-event": "ping",
		});
		expect(ping.status).toBe(200);
		expect(await queuedJobs(s.t)).toHaveLength(0);

		const ok = await post(`/api/deploy/compose/${token}`);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({
			message: "Compose deployed successfully",
		});
		const jobs = await queuedJobs(s.t);
		expect(jobs.map((j) => j.spec.kind)).toEqual(["compose.deploy"]);

		await s.alice.mutation(api.compose.crud.update, {
			composeId,
			autoDeploy: false,
		});
		expect((await post(`/api/deploy/compose/${token}`)).status).toBe(400);
	});

	test("git composes match branch and watch paths", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const gitProviderId = await addGithubProvider(s.t);
		await useGithubSource(s, composeId, gitProviderId, {
			watchPaths: ["deploy/**"],
		});
		const token = (await s.alice.query(api.compose.crud.get, { composeId }))
			?.refreshToken;
		const push = (ref: string, files: string[]) =>
			s.t.fetch(`/api/deploy/compose/${token}`, {
				method: "POST",
				headers: { "x-github-event": "push" },
				body: JSON.stringify({
					ref,
					after: "abc123",
					repository: {
						name: "web",
						full_name: "acme/web",
						owner: { login: "acme", name: "acme" },
					},
					head_commit: { id: "abc123", message: "Change compose" },
					commits: [{ added: [], modified: files, removed: [] }],
				}),
			});

		const wrongBranch = await push("refs/heads/dev", ["deploy/x.yml"]);
		expect(wrongBranch.status).toBe(301);
		expect(await wrongBranch.json()).toEqual({ message: "Branch Not Match" });
		const unrelated = await push("refs/heads/main", ["README.md"]);
		expect(unrelated.status).toBe(301);
		expect(await unrelated.json()).toEqual({
			message: "Watch Paths Not Match",
		});
		expect(await queuedJobs(s.t)).toHaveLength(0);

		expect((await push("refs/heads/main", ["deploy/x.yml"])).status).toBe(200);
		const deployment = await s.t.run((ctx) =>
			ctx.db.query("deployments").first(),
		);
		expect(deployment).toMatchObject({
			title: "Change compose",
			commit: { sha: "abc123" },
		});
	});

	test("gitEvents.handle fans GitHub App events out to matching composes", async () => {
		const s = await seed();
		const gitProviderId = await addGithubProvider(s.t);
		const pushCompose = await createCompose(s);
		await useGithubSource(s, pushCompose, gitProviderId);
		const tagCompose = await createCompose(s);
		await useGithubSource(s, tagCompose, gitProviderId);
		await s.alice.mutation(api.compose.crud.update, {
			composeId: tagCompose,
			triggerType: "tag",
		});
		const disabled = await createCompose(s);
		await useGithubSource(s, disabled, gitProviderId);
		await s.alice.mutation(api.compose.crud.update, {
			composeId: disabled,
			autoDeploy: false,
		});

		const handle = (event: GitEvent, organizationId = "org1") =>
			s.t.mutation(internal.compose.gitEvents.handle, {
				organizationId,
				gitProviderId,
				event,
			});

		expect(await handle(pushEvent(), "org2")).toEqual({ triggered: 0 });
		expect(await handle(pushEvent({ branch: "dev" }))).toEqual({
			triggered: 0,
		});
		expect(
			await handle(
				pushEvent({
					repo: { owner: "acme", name: "other", fullName: "acme/other" },
				}),
			),
		).toEqual({ triggered: 0 });
		expect(await handle(pushEvent({ skipCi: true }))).toEqual({
			triggered: 0,
		});
		expect(await handle(pushEvent())).toEqual({ triggered: 1 });
		expect(
			await handle(
				pushEvent({ kind: "tag", branch: undefined, tag: "v1.0.0" }),
			),
		).toEqual({ triggered: 1 });

		const jobs = await queuedJobs(s.t);
		expect(
			jobs.map((j) => (j.spec as { composeId: string }).composeId).sort(),
		).toEqual([pushCompose, tagCompose].sort());
		const titles = (
			await s.t.run((ctx) => ctx.db.query("deployments").collect())
		).map((d) => d.title);
		expect(titles).toEqual(["Ship it", "Tag created: v1.0.0"]);
	});
});

describe("templates", () => {
	const TOML = `[variables]
main_domain = "\${domain}"
secret = "\${password:16}"

[[config.domains]]
serviceName = "plausible"
port = 8000
host = "\${main_domain}"

[config.env]
SECRET = "\${secret}"
APP = "\${APP_NAME}"

[[config.mounts]]
filePath = "/clickhouse/config.xml"
content = "<host>\${main_domain}</host>"
`;

	beforeEach(() => {
		vi.stubEnv("TEMPLATES_BASE_URL", "https://templates.example.com");
		const base = "https://templates.example.com/blueprints/plausible";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === `${base}/template.toml`) return new Response(TOML);
				if (url === `${base}/docker-compose.yml`) {
					return new Response(
						"services:\n  plausible:\n    image: plausible\n",
					);
				}
				return new Response("not found", { status: 404 });
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("deployTemplate creates the compose with env, domains and file mounts", async () => {
		const s = await seed();
		await expect(
			s.bob.action(api.compose.templates.deployTemplate, {
				environmentId: s.environmentId,
				templateId: "plausible",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			s.mallory.action(api.compose.templates.deployTemplate, {
				environmentId: s.environmentId,
				templateId: "plausible",
			}),
		).rejects.toThrow(/Not a member/);

		const composeId = await s.alice.action(
			api.compose.templates.deployTemplate,
			{ environmentId: s.environmentId, templateId: "plausible" },
		);
		const compose = await s.alice.query(api.compose.crud.get, { composeId });
		expect(compose).toMatchObject({
			name: "plausible",
			sourceType: "raw",
			composeType: "docker-compose",
		});
		expect(compose?.appName).toMatch(/^shop-plausible-[a-z0-9]{6}$/);
		expect(
			await s.alice.query(api.compose.crud.getFile, { composeId }),
		).toContain("image: plausible");
		const env = await s.alice.query(api.compose.crud.getEnv, { composeId });
		expect(env).toContain(`APP=${compose?.appName}`);
		expect(env).toMatch(/SECRET=\S{16}/);
		const domains = await s.alice.query(api.infra.domains.listByOwner, {
			owner: { kind: "compose", id: composeId },
		});
		expect(domains).toHaveLength(1);
		expect(domains[0]).toMatchObject({
			serviceName: "plausible",
			port: 8000,
			https: false,
			certificateType: "none",
		});
		expect(domains[0]?.host).toMatch(/\.sslip\.io$/);
		const mounts = await s.alice.query(api.compose.mounts.list, { composeId });
		expect(mounts).toHaveLength(1);
		expect(mounts[0]).toMatchObject({
			type: "file",
			filePath: "clickhouse/config.xml",
		});
		expect(mounts[0]?.type === "file" ? mounts[0].content : "").toContain(
			domains[0]?.host,
		);
	});

	test("importTemplate replaces file, env, domains and mounts", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		await s.alice.mutation(api.infra.domains.create, {
			owner: { kind: "compose", id: composeId },
			host: "old.example.com",
			https: false,
			certificateType: "none",
			serviceName: "web",
			port: 80,
		});
		const base64 = btoa(
			JSON.stringify({
				compose: "services:\n  plausible:\n    image: plausible\n",
				config: TOML,
			}),
		);
		await expect(
			s.mallory.action(api.compose.templates.importTemplate, {
				composeId,
				base64,
			}),
		).rejects.toThrow(/Not a member/);
		await s.alice.action(api.compose.templates.importTemplate, {
			composeId,
			base64,
		});
		expect(
			await s.alice.query(api.compose.crud.getFile, { composeId }),
		).toContain("image: plausible");
		const domains = await s.alice.query(api.infra.domains.listByOwner, {
			owner: { kind: "compose", id: composeId },
		});
		expect(domains.map((d) => d.serviceName)).toEqual(["plausible"]);
	});

	test("importTemplate stores the values the preview showed", async () => {
		const s = await seed();
		const composeId = await createCompose(s);
		const base64 = btoa(
			JSON.stringify({
				compose: "services:\n  plausible:\n    image: plausible\n",
				config: TOML,
			}),
		);
		const preview = await s.alice.action(
			api.compose.templates.processTemplate,
			{ composeId, base64 },
		);
		await s.alice.action(api.compose.templates.importTemplate, {
			composeId,
			base64,
			previewed: { compose: preview.compose, ...preview.template },
		});
		expect(await s.alice.query(api.compose.crud.getEnv, { composeId })).toBe(
			preview.template.envs.join("\n"),
		);
		await expect(
			s.mallory.action(api.compose.templates.importTemplate, {
				composeId,
				base64,
				previewed: { compose: preview.compose, ...preview.template },
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("a project import stores the values its preview showed", async () => {
		// Projects → Import: preview for the typed app name, create the
		// service, then import what the review showed.
		const s = await seed();
		const base64 = btoa(
			JSON.stringify({
				compose: "services:\n  plausible:\n    image: plausible\n",
				config: TOML,
			}),
		);
		const preview = await s.alice.action(api.platform.templatesSync.preview, {
			organizationId: "org1",
			appName: "shop-plausible",
			base64,
		});
		const composeId = await s.alice.mutation(api.compose.crud.create, {
			environmentId: s.environmentId,
			name: "Plausible",
			appName: "shop-plausible",
			composeType: "docker-compose",
		});
		await s.alice.action(api.compose.templates.importTemplate, {
			composeId,
			base64,
			previewed: {
				compose: preview.composeFile,
				envs: preview.envs,
				domains: preview.domains,
				mounts: preview.mounts,
			},
		});
		const env = await s.alice.query(api.compose.crud.getEnv, { composeId });
		expect(env).toBe(preview.envs.join("\n"));
		expect(env).toMatch(/^SECRET=.{16}$/m);
		const domains = await s.alice.query(api.infra.domains.listByOwner, {
			owner: { kind: "compose", id: composeId },
		});
		expect(domains.map((d) => d.host)).toEqual(
			preview.domains.map((d) => d.host),
		);
	});
});
