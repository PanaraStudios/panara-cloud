import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import type { GitSource } from "../tables/sources";
import {
	addAgent,
	addMember,
	addServer,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import { hmacSha256Hex } from "./webhooks";

const mockFetch = (
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url, init });
			return await handler(url, init);
		},
	);
	return calls;
};

afterEach(() => vi.unstubAllGlobals());

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org2", "mallory", "owner");
	const agentId = await addAgent(t);
	return { t, agent: asAgent(t, agentId) };
};

const claimJob = async (
	t: TestConvex,
	agent: ReturnType<typeof asAgent>,
	organizationId = "org1",
) => {
	await t.run((ctx) =>
		ctx.db.insert("jobs", {
			organizationId,
			partition: "local",
			group: `test:${Math.random()}`,
			spec: { kind: "noop", message: "build" },
			status: "queued",
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
		}),
	);
	const claim = await agent.mutation(api.agent.claimNext, {});
	if (!claim) throw new Error("expected a claim");
	return { jobId: claim.jobId, leaseId: claim.leaseId };
};

const connectGitlab = async (t: TestConvex, user: string, org: string) => {
	const gitProviderId = await asUser(t, user).action(
		api.sources.gitlab.create,
		{
			organizationId: org,
			name: "GitLab",
			gitlabUrl: "https://gitlab.example.com",
			applicationId: "app",
			secret: "client-secret",
		},
	);
	const url = new URL(
		await asUser(t, user).mutation(api.sources.gitlab.beginAuthorize, {
			gitProviderId,
		}),
	);
	// expires_in shorter than the refresh margin: the next use must refresh.
	mockFetch(() =>
		Response.json({
			access_token: "old-access",
			refresh_token: "refresh-1",
			expires_in: 10,
		}),
	);
	await t.fetch(
		`/sources/gitlab/callback?code=c&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
	);
	vi.unstubAllGlobals();
	return gitProviderId;
};

const gitlabSource = (gitProviderId: Id<"gitProviders">): GitSource => ({
	type: "gitlab",
	gitProviderId,
	owner: "group",
	repository: "app",
	pathNamespace: "group/app",
	branch: "main",
	buildPath: "/",
	submodules: false,
});

describe("mintCloneCredentials", () => {
	test("requires an agent holding the job's lease", async () => {
		const { t, agent } = await seed();
		const gitProviderId = await connectGitlab(t, "alice", "org1");
		const lease = await claimJob(t, agent);
		const source = gitlabSource(gitProviderId);
		await expect(
			asUser(t, "alice").action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source,
			}),
		).rejects.toThrow(/Agent authentication required/);
		await expect(
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				leaseId: "stale",
				source,
			}),
		).rejects.toThrow(/Lease lost/);
	});

	test("refuses providers of another organization", async () => {
		const { t, agent } = await seed();
		const foreign = await connectGitlab(t, "mallory", "org2");
		const lease = await claimJob(t, agent, "org1");
		await expect(
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source: gitlabSource(foreign),
			}),
		).rejects.toThrow(/Git provider not found/);
	});

	test("refreshes a GitLab token once for concurrent clones", async () => {
		const { t, agent } = await seed();
		const gitProviderId = await connectGitlab(t, "alice", "org1");
		const lease = await claimJob(t, agent);
		let refreshes = 0;
		const calls = mockFetch(async (url, init) => {
			if (url.endsWith("/oauth/token")) {
				refreshes++;
				const body = new URLSearchParams(String(init?.body));
				// GitLab refresh tokens are single use.
				if (body.get("refresh_token") !== "refresh-1") {
					return new Response("invalid_grant", { status: 400 });
				}
				await new Promise((r) => setTimeout(r, 100));
				return Response.json({
					access_token: "new-access",
					refresh_token: "refresh-2",
					expires_in: 7200,
				});
			}
			return new Response("unexpected", { status: 500 });
		});
		const source = gitlabSource(gitProviderId);
		const [a, b] = await Promise.all([
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source,
			}),
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source,
			}),
		]);
		expect(refreshes).toBe(1);
		expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
		for (const result of [a, b]) {
			expect(result).toMatchObject({
				url: "https://gitlab.example.com/group/app.git",
				branch: "main",
				credentials: {
					type: "basic",
					username: "oauth2",
					password: "new-access",
				},
			});
			expect(result.url).not.toContain("new-access");
		}
		// The fresh token is reused without another refresh.
		await agent.action(api.sources.agent.mintCloneCredentials, {
			...lease,
			source,
		});
		expect(refreshes).toBe(1);
	});

	test("custom git: SSH key of the org, and URL credentials moved out of the URL", async () => {
		const { t, agent } = await seed();
		const sshKeyId = await asUser(t, "alice").action(api.sshKeys.create, {
			organizationId: "org1",
			name: "deploy",
			publicKey: "ssh-ed25519 AAAA test",
			privateKey:
				"-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n-----END OPENSSH PRIVATE KEY-----",
		});
		const foreignKey = await asUser(t, "mallory").action(api.sshKeys.create, {
			organizationId: "org2",
			name: "deploy",
			publicKey: "ssh-ed25519 AAAA test",
			privateKey:
				"-----BEGIN OPENSSH PRIVATE KEY-----\nother\n-----END OPENSSH PRIVATE KEY-----",
		});
		const lease = await claimJob(t, agent);
		const base = {
			type: "git" as const,
			branch: "main",
			buildPath: "/",
			submodules: true,
		};
		const ssh = await agent.action(api.sources.agent.mintCloneCredentials, {
			...lease,
			source: { ...base, url: "git@example.com:acme/app.git", sshKeyId },
		});
		expect(ssh.credentials).toMatchObject({ type: "ssh" });
		expect(
			ssh.credentials?.type === "ssh" && ssh.credentials.privateKey,
		).toContain("key-material");
		expect(
			(await t.run((ctx) => ctx.db.get("sshKeys", sshKeyId)))?.lastUsedAt,
		).toBeTypeOf("number");
		await expect(
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source: {
					...base,
					url: "git@example.com:acme/app.git",
					sshKeyId: foreignKey,
				},
			}),
		).rejects.toThrow(/SSH key not found/);

		const https = await agent.action(api.sources.agent.mintCloneCredentials, {
			...lease,
			source: {
				...base,
				url: "https://bob:s3cret@git.example.com/acme/app.git",
			},
		});
		expect(https).toMatchObject({
			url: "https://git.example.com/acme/app.git",
			credentials: { type: "basic", username: "bob", password: "s3cret" },
		});
	});

	test("GitHub gets an installation token from the app's private key", async () => {
		const { t, agent } = await seed();
		const keys = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const der = new Uint8Array(
			await crypto.subtle.exportKey("pkcs8", keys.privateKey),
		);
		const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(
			String.fromCharCode(...der),
		)
			.match(/.{1,64}/g)
			?.join("\n")}\n-----END PRIVATE KEY-----\n`;
		const gitProviderId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("gitProviders", {
				organizationId: "org1",
				userId: "alice",
				name: "GitHub",
				providerType: "github",
				sharedWithOrganization: false,
				config: {
					type: "github",
					githubUrl: "https://github.com",
					appId: 123,
					installationId: "42",
				},
				githubInstallationId: "42",
				connected: true,
			});
			await ctx.db.insert("secrets", {
				organizationId: "org1",
				kind: "sources.gitProvider.githubPrivateKey",
				ownerId: id,
				...(await encryptSecret(pem)),
			});
			return id;
		});
		const calls = mockFetch((url) =>
			url.endsWith("/app/installations/42/access_tokens")
				? Response.json(
						{ token: "ghs_installation", expires_at: "2030-01-01T00:00:00Z" },
						{ status: 201 },
					)
				: new Response("not found", { status: 404 }),
		);
		const lease = await claimJob(t, agent);
		const spec = await agent.action(api.sources.agent.mintCloneCredentials, {
			...lease,
			source: {
				type: "github",
				gitProviderId,
				owner: "acme",
				repository: "web",
				branch: "main",
				buildPath: "/",
				submodules: true,
			},
		});
		expect(spec).toEqual({
			url: "https://github.com/acme/web.git",
			branch: "main",
			submodules: true,
			credentials: {
				type: "basic",
				username: "x-access-token",
				password: "ghs_installation",
			},
			expiresAt: Date.parse("2030-01-01T00:00:00Z"),
		});
		const auth =
			new Headers(calls[0]?.init?.headers).get("authorization") ?? "";
		expect(auth).toMatch(/^bearer ey/i);
	});

	test("Bitbucket API tokens use the fixed clone username", async () => {
		const { t, agent } = await seed();
		const gitProviderId = await asUser(t, "alice").action(
			api.sources.bitbucket.create,
			{
				organizationId: "org1",
				name: "BB",
				email: "me@example.com",
				apiToken: "ATATT-token",
			},
		);
		const lease = await claimJob(t, agent);
		const spec = await agent.action(api.sources.agent.mintCloneCredentials, {
			...lease,
			source: {
				type: "bitbucket",
				gitProviderId,
				owner: "ws",
				repository: "My Repo",
				repositorySlug: "my-repo",
				branch: "main",
				buildPath: "/",
				submodules: false,
			},
		});
		expect(spec).toMatchObject({
			url: "https://bitbucket.org/ws/my-repo.git",
			credentials: {
				type: "basic",
				username: "x-bitbucket-api-token-auth",
				password: "ATATT-token",
			},
		});
	});

	test("rejects a source whose type doesn't match the provider", async () => {
		const { t, agent } = await seed();
		const gitProviderId = await connectGitlab(t, "alice", "org1");
		const lease = await claimJob(t, agent);
		await expect(
			agent.action(api.sources.agent.mintCloneCredentials, {
				...lease,
				source: {
					type: "github",
					gitProviderId,
					owner: "a",
					repository: "b",
					branch: "main",
					buildPath: "/",
					submodules: false,
				},
			}),
		).rejects.toThrow(/not a github provider/);
	});
});

describe("registries", () => {
	const createRegistry = (t: TestConvex) =>
		asUser(t, "alice").action(api.sources.registries.create, {
			organizationId: "org1",
			registryName: "GHCR",
			registryUrl: "ghcr.io",
			username: "AWS",
			password: "registry-password-value",
		});

	test("admin-only CRUD with the password kept out of documents", async () => {
		const { t } = await seed();
		await addMember(t, "org1", "bob", "member");
		await expect(
			asUser(t, "bob").action(api.sources.registries.create, {
				organizationId: "org1",
				registryName: "x",
				registryUrl: "ghcr.io",
				username: "u",
				password: "p",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "alice").action(api.sources.registries.create, {
				organizationId: "org1",
				registryName: "x",
				registryUrl: "ghcr.io; rm -rf /",
				username: "u",
				password: "p",
			}),
		).rejects.toThrow(/hostname/);
		const { registryId, jobId } = await createRegistry(t);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: "local",
			spec: { kind: "sources.registryTest" },
		});
		await expect(
			asUser(t, "bob").query(api.sources.registries.list, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		expect(
			await asUser(t, "bob").query(api.sources.registries.listNames, {
				organizationId: "org1",
			}),
		).toMatchObject([{ _id: registryId, registryName: "GHCR" }]);
		await expect(
			asUser(t, "mallory").query(api.sources.registries.get, { registryId }),
		).rejects.toThrow(/Not a member/);
		const listed = await asUser(t, "alice").query(api.sources.registries.list, {
			organizationId: "org1",
		});
		expect(listed[0]).toMatchObject({
			username: "AWS",
			registryUrl: "ghcr.io",
		});
		const all = JSON.stringify(
			await t.run(async (ctx) => ({
				r: await ctx.db.query("registries").collect(),
				s: await ctx.db.query("secrets").collect(),
				j: await ctx.db.query("jobs").collect(),
			})),
		);
		expect(all).not.toContain("registry-password-value");
		expect(JSON.stringify(listed)).not.toContain("password");
	});

	test("login test round trip and lease-guarded credentials", async () => {
		const { t, agent } = await seed();
		const { registryId, testId, jobId } = await createRegistry(t);
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim?.jobId).toBe(jobId);
		if (!claim) throw new Error("expected a claim");
		const lease = { jobId, leaseId: claim.leaseId };
		await expect(
			agent.query(api.sources.agent.getRegistryTestContext, {
				jobId,
				leaseId: "x",
			}),
		).rejects.toThrow(/Lease lost/);
		expect(
			await agent.query(api.sources.agent.getRegistryTestContext, lease),
		).toEqual({
			registryUrl: "ghcr.io",
			username: "AWS",
			password: "registry-password-value",
		});
		await agent.mutation(api.sources.agent.reportRegistryTest, {
			...lease,
			ok: true,
		});
		expect(
			await asUser(t, "alice").query(api.sources.registries.getTest, {
				testId,
			}),
		).toMatchObject({ status: "succeeded" });

		expect(
			await agent.query(api.sources.agent.getRegistryCredentials, {
				...lease,
				registryId,
			}),
		).toMatchObject({
			registryUrl: "ghcr.io",
			password: "registry-password-value",
		});
		const foreignArgs = {
			organizationId: "org2",
			registryName: "Other",
			registryUrl: "",
			username: "u",
			password: "p",
		};
		await expect(
			asUser(t, "mallory").action(api.sources.registries.create, foreignArgs),
		).rejects.toThrow(/Select a server to test the registry on/);
		const foreign = await asUser(t, "mallory").action(
			api.sources.registries.create,
			{ ...foreignArgs, serverId: await addServer(t, "org2") },
		);
		await expect(
			agent.query(api.sources.agent.getRegistryCredentials, {
				...lease,
				registryId: foreign.registryId,
			}),
		).rejects.toThrow(/Registry not found/);
	});

	test("draft credentials are tested on a server and deleted after the report", async () => {
		const { t, agent } = await seed();
		const serverId = await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org1",
				name: "s",
				ipAddress: "10.0.0.1",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const foreignServer = await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org2",
				name: "s",
				ipAddress: "10.0.0.2",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const draft = {
			organizationId: "org1",
			registryUrl: "registry.example.com:5000",
			username: "me",
			password: "draft-password",
		};
		await expect(
			asUser(t, "alice").action(api.sources.registries.test, {
				...draft,
				serverId: foreignServer,
			}),
		).rejects.toThrow(/Server not found/);
		const { testId, jobId } = await asUser(t, "alice").action(
			api.sources.registries.test,
			{ ...draft, serverId },
		);
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			partition: serverId,
		});
		const claim = await agent.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");
		const lease = { jobId, leaseId: claim.leaseId };
		expect(
			(await agent.query(api.sources.agent.getRegistryTestContext, lease))
				.password,
		).toBe("draft-password");
		await agent.mutation(api.sources.agent.reportRegistryTest, {
			...lease,
			ok: false,
			error: "unauthorized",
		});
		expect(
			await asUser(t, "alice").query(api.sources.registries.getTest, {
				testId,
			}),
		).toMatchObject({ status: "failed", error: "unauthorized" });
		expect(await t.run((ctx) => ctx.db.query("secrets").collect())).toEqual([]);
	});
});

describe("GitHub App webhook", () => {
	const seedGithub = async (t: TestConvex) =>
		await t.run(async (ctx) => {
			const gitProviderId = await ctx.db.insert("gitProviders", {
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
			await ctx.db.insert("secrets", {
				organizationId: "org1",
				kind: "sources.gitProvider.githubWebhookSecret",
				ownerId: gitProviderId,
				...(await encryptSecret("hook-secret")),
			});
			return gitProviderId;
		});

	const post = async (
		t: TestConvex,
		event: string,
		body: string,
		secret: string,
		path = "/webhooks/github",
	) =>
		await t.fetch(path, {
			method: "POST",
			headers: {
				"x-github-event": event,
				"x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
				"content-type": "application/json",
			},
			body,
		});

	test("verifies the signature over the raw body before acting", async () => {
		const { t } = await seed();
		await seedGithub(t);
		const push = JSON.stringify({
			ref: "refs/heads/main",
			installation: { id: 42 },
			repository: { name: "web", owner: { login: "acme" } },
			head_commit: { id: "abc", message: "change" },
			commits: [],
		});
		const ok = await post(t, "push", push, "hook-secret");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			message: "No apps to deploy",
			triggered: 0,
		});
		expect((await post(t, "push", push, "wrong-secret")).status).toBe(401);
		const unknown = JSON.stringify({ installation: { id: 7 } });
		expect((await post(t, "push", unknown, "hook-secret")).status).toBe(400);
		expect(
			(
				await t.fetch("/webhooks/github", {
					method: "POST",
					headers: { "x-github-event": "push" },
					body: push,
				})
			).status,
		).toBe(401);
		const ping = JSON.stringify({ zen: "z", installation: { id: 42 } });
		expect(
			await (await post(t, "ping", ping, "hook-secret")).json(),
		).toMatchObject({
			message: "Ping received, webhook is active",
		});
		const skip = JSON.stringify({
			ref: "refs/heads/main",
			installation: { id: 42 },
			repository: { name: "web", owner: { login: "acme" } },
			head_commit: { id: "abc", message: "docs [skip ci]" },
		});
		expect(
			await (await post(t, "push", skip, "hook-secret")).json(),
		).toMatchObject({
			message: "Deployment skipped: commit message contains skip keyword",
		});
	});

	test("the /api/deploy/github path reaches the same handler", async () => {
		const { t } = await seed();
		await seedGithub(t);
		const ping = JSON.stringify({ zen: "z", installation: { id: 42 } });
		const ok = await post(t, "ping", ping, "hook-secret", "/api/deploy/github");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			message: "Ping received, webhook is active",
		});
		expect(
			(await post(t, "ping", ping, "wrong-secret", "/api/deploy/github"))
				.status,
		).toBe(401);
	});
});
