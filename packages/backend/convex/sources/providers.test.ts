import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";
import { giteaRepositories } from "./remote";
import { openSshPrivateKey } from "./sshKeyFormat";

const CLIENT_SECRET = "gloas-client-secret-value";
const ACCESS_TOKEN = "glpat-access-token-value";
const REFRESH_TOKEN = "glrt-refresh-token-value";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org1", "carol", "admin");
	await addMember(t, "org2", "mallory", "owner");
	return t;
};

const createGitlab = (t: TestConvex, user = "alice") =>
	asUser(t, user).action(api.sources.gitlab.create, {
		organizationId: "org1",
		name: "GitLab",
		gitlabUrl: "https://gitlab.example.com",
		applicationId: "app-id",
		secret: CLIENT_SECRET,
	});

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

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("git providers", () => {
	test("only admins create providers; other orgs can't see them", async () => {
		const t = await seed();
		await expect(createGitlab(t, "bob")).rejects.toThrow(
			/Requires the [a-zA-Z]+\.[a-z]+ permission/,
		);
		await expect(
			asUser(t, "mallory").action(api.sources.gitlab.create, {
				organizationId: "org1",
				name: "x",
				applicationId: "a",
				secret: "s",
			}),
		).rejects.toThrow(/Not a member/);

		const gitProviderId = await createGitlab(t);
		await expect(
			asUser(t, "mallory").query(api.sources.providers.get, { gitProviderId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "mallory").mutation(api.sources.providers.remove, {
				gitProviderId,
			}),
		).rejects.toThrow(/Not a member/);
		expect(
			await asUser(t, "mallory").query(api.sources.providers.list, {
				organizationId: "org2",
			}),
		).toEqual([]);
	});

	test("members see a provider only once its owner shares it", async () => {
		const t = await seed();
		const gitProviderId = await createGitlab(t);
		const bob = asUser(t, "bob");
		expect(
			await bob.query(api.sources.providers.list, { organizationId: "org1" }),
		).toEqual([]);
		await expect(
			bob.query(api.sources.providers.get, { gitProviderId }),
		).rejects.toThrow(/don't have access/);
		await expect(
			bob.action(api.sources.gitlab.listRepositories, { gitProviderId }),
		).rejects.toThrow(/don't have access/);

		// Admins see everything but only the creator may share.
		expect(
			await asUser(t, "carol").query(api.sources.providers.list, {
				organizationId: "org1",
			}),
		).toHaveLength(1);
		await expect(
			asUser(t, "carol").mutation(api.sources.providers.toggleShare, {
				gitProviderId,
				sharedWithOrganization: true,
			}),
		).rejects.toThrow(/Only the owner/);
		await asUser(t, "alice").mutation(api.sources.providers.toggleShare, {
			gitProviderId,
			sharedWithOrganization: true,
		});
		const list = await bob.query(api.sources.providers.list, {
			organizationId: "org1",
		});
		expect(list).toMatchObject([
			{
				_id: gitProviderId,
				isOwner: false,
				connected: false,
				providerType: "gitlab",
			},
		]);
		await expect(
			bob.mutation(api.sources.providers.remove, { gitProviderId }),
		).rejects.toThrow(/gitProviders\.delete permission/);
		await expect(
			bob.mutation(api.sources.gitlab.beginAuthorize, { gitProviderId }),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
	});

	test("secrets are encrypted and never listed", async () => {
		const t = await seed();
		const gitProviderId = await createGitlab(t);
		await asUser(t, "alice").action(api.sources.bitbucket.create, {
			organizationId: "org1",
			name: "BB",
			email: "me@example.com",
			apiToken: "ATATT-bitbucket-token",
		});
		await asUser(t, "alice").action(api.sources.gitlab.update, {
			gitProviderId,
			groupName: "acme",
			secret: "",
		});
		const everything = await t.run(async (ctx) => ({
			providers: await ctx.db.query("gitProviders").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		const dump = JSON.stringify(everything);
		expect(dump).not.toContain(CLIENT_SECRET);
		expect(dump).not.toContain("ATATT-bitbucket-token");
		expect(everything.secrets.map((s) => s.kind).sort()).toEqual([
			"sources.gitProvider.apiToken",
			"sources.gitProvider.clientSecret",
		]);
		const listed = await asUser(t, "alice").query(api.sources.providers.list, {
			organizationId: "org1",
		});
		expect(JSON.stringify(listed)).not.toMatch(/secret-value|ATATT/);
		expect(listed.find((p) => p._id === gitProviderId)?.config).toMatchObject({
			groupName: "acme",
		});

		await asUser(t, "carol").mutation(api.sources.providers.remove, {
			gitProviderId,
		});
		const kinds = await t.run(async (ctx) =>
			(await ctx.db.query("secrets").collect()).map((s) => s.kind),
		);
		expect(kinds).toEqual(["sources.gitProvider.apiToken"]);
	});

	test("bitbucket needs credentials", async () => {
		const t = await seed();
		await expect(
			asUser(t, "alice").action(api.sources.bitbucket.create, {
				organizationId: "org1",
				name: "BB",
				username: "me",
			}),
		).rejects.toThrow(/API token or app password/);
		await expect(
			asUser(t, "alice").action(api.sources.bitbucket.create, {
				organizationId: "org1",
				name: "BB",
				apiToken: "tok",
			}),
		).rejects.toThrow(/email is required/);
	});
});

describe("gitea organization", () => {
	const createGitea = (
		t: TestConvex,
		organizationName?: string,
		user = "alice",
	) =>
		asUser(t, user).action(api.sources.gitea.create, {
			organizationId: "org1",
			name: "Gitea",
			giteaUrl: "https://gitea.example.com",
			clientId: "client",
			clientSecret: "secret",
			organizationName,
		});

	const config = async (t: TestConvex, gitProviderId: Id<"gitProviders">) =>
		(await t.run((ctx) => ctx.db.get("gitProviders", gitProviderId)))?.config;

	test("is trimmed, cleared when empty and validated", async () => {
		const t = await seed();
		const gitProviderId = await createGitea(t, "  acme  ");
		expect(await config(t, gitProviderId)).toMatchObject({
			organizationName: "acme",
		});

		await asUser(t, "alice").action(api.sources.gitea.update, {
			gitProviderId,
			name: "Renamed",
		});
		expect(await config(t, gitProviderId)).toMatchObject({
			organizationName: "acme",
		});

		await asUser(t, "alice").action(api.sources.gitea.update, {
			gitProviderId,
			organizationName: " ",
		});
		expect(await config(t, gitProviderId)).not.toHaveProperty(
			"organizationName",
		);

		expect(await config(t, await createGitea(t, ""))).not.toHaveProperty(
			"organizationName",
		);
		await expect(createGitea(t, "acme/../x")).rejects.toThrow(
			/Invalid organization name/,
		);
		await expect(
			asUser(t, "alice").action(api.sources.gitea.update, {
				gitProviderId,
				organizationName: "a b",
			}),
		).rejects.toThrow(/Invalid organization name/);
	});

	test("only admins of the provider's organization change it", async () => {
		const t = await seed();
		const gitProviderId = await createGitea(t, "acme");
		await expect(createGitea(t, "acme", "mallory")).rejects.toThrow(
			/Not a member/,
		);
		await expect(
			asUser(t, "mallory").action(api.sources.gitea.update, {
				gitProviderId,
				organizationName: "evil",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "bob").action(api.sources.gitea.update, {
				gitProviderId,
				organizationName: "evil",
			}),
		).rejects.toThrow(/gitProviders.create permission/);
		expect(await config(t, gitProviderId)).toMatchObject({
			organizationName: "acme",
		});
	});

	test("organization repositories are merged with the user's, deduped", async () => {
		const repo = (id: number, owner: string, name: string) => ({
			id,
			name,
			full_name: `${owner}/${name}`,
			html_url: `https://gitea.example.com/${owner}/${name}`,
			owner: { login: owner },
		});
		const calls = mockFetch((url) => {
			const { pathname, searchParams } = new URL(url);
			const page = searchParams.get("page");
			if (pathname === "/api/v1/user/repos") {
				return Response.json(
					page === "1" ? [repo(1, "me", "app"), repo(2, "acme", "api")] : [],
				);
			}
			if (pathname === "/api/v1/orgs/acme/repos") {
				return Response.json(
					page === "1"
						? Array.from({ length: 50 }, (_, i) => repo(2 + i, "acme", `r${i}`))
						: page === "2"
							? [repo(100, "acme", "last")]
							: [],
				);
			}
			return new Response("not found", { status: 404 });
		});
		const repositories = await giteaRepositories(
			{
				type: "gitea",
				giteaUrl: "https://gitea.example.com",
				organizationName: "acme",
			},
			"token",
		);
		expect(repositories.map((r) => r.id)).toEqual([
			1,
			2,
			...Array.from({ length: 49 }, (_, i) => 3 + i),
			100,
		]);
		expect(repositories[1]).toMatchObject({ owner: "acme", name: "api" });
		expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
			"/api/v1/user/repos",
			"/api/v1/orgs/acme/repos",
			"/api/v1/orgs/acme/repos",
		]);
		expect(
			(calls[0]?.init?.headers as Record<string, string>).Authorization,
		).toBe("token token");

		mockFetch(() => Response.json([repo(1, "me", "app")]));
		expect(
			await giteaRepositories(
				{ type: "gitea", giteaUrl: "https://gitea.example.com" },
				"token",
			),
		).toHaveLength(1);
	});
});

describe("bitbucket test connection", () => {
	const createBitbucket = (t: TestConvex) =>
		asUser(t, "alice").action(api.sources.bitbucket.create, {
			organizationId: "org1",
			name: "BB",
			username: "stored-user",
			email: "stored@example.com",
			workspaceName: "stored-ws",
			apiToken: "stored-token",
		});

	const bitbucketApi = () =>
		mockFetch(() =>
			Response.json({
				values: [
					{
						name: "app",
						slug: "app",
						full_name: "ws/app",
						workspace: { slug: "ws" },
						links: { html: { href: "https://bitbucket.org/ws/app" } },
					},
				],
			}),
		);

	const basicAuth = (call: { init?: RequestInit } | undefined) =>
		atob(
			(call?.init?.headers as Record<string, string>).Authorization.replace(
				"Basic ",
				"",
			),
		);

	test("uses unsaved form values over the stored ones", async () => {
		const t = await seed();
		const gitProviderId = await createBitbucket(t);
		const calls = bitbucketApi();
		const alice = asUser(t, "alice");

		expect(
			await alice.action(api.sources.bitbucket.testConnection, {
				gitProviderId,
			}),
		).toBe("Found 1 repositories");
		expect(calls[0]?.url).toContain("/repositories/stored-ws?");
		expect(basicAuth(calls[0])).toBe("stored@example.com:stored-token");

		await alice.action(api.sources.bitbucket.testConnection, {
			gitProviderId,
			username: "stored-user",
			email: "new@example.com",
			workspaceName: "new-ws",
			apiToken: "",
			appPassword: "",
		});
		expect(calls[1]?.url).toContain("/repositories/new-ws?");
		expect(basicAuth(calls[1])).toBe("new@example.com:stored-token");

		await alice.action(api.sources.bitbucket.testConnection, {
			gitProviderId,
			email: "new@example.com",
			workspaceName: "",
			apiToken: "new-token",
		});
		expect(calls[2]?.url).toContain("/repositories/stored-user?");
		expect(basicAuth(calls[2])).toBe("new@example.com:new-token");

		await expect(
			alice.action(api.sources.bitbucket.testConnection, {
				gitProviderId,
				email: "",
			}),
		).rejects.toThrow(/email is required/);
		await expect(
			alice.action(api.sources.bitbucket.testConnection, {
				gitProviderId,
				email: "not-an-email",
			}),
		).rejects.toThrow(/Invalid email/);
		expect(calls).toHaveLength(3);

		const stored = await t.run((ctx) =>
			ctx.db.get("gitProviders", gitProviderId),
		);
		expect(stored?.config).toMatchObject({
			email: "stored@example.com",
			workspaceName: "stored-ws",
		});
	});

	test("form values need the admin role in the provider's organization", async () => {
		const t = await seed();
		const gitProviderId = await createBitbucket(t);
		const calls = bitbucketApi();
		await asUser(t, "alice").mutation(api.sources.providers.toggleShare, {
			gitProviderId,
			sharedWithOrganization: true,
		});
		await expect(
			asUser(t, "bob").action(api.sources.bitbucket.testConnection, {
				gitProviderId,
			}),
		).resolves.toBe("Found 1 repositories");
		await expect(
			asUser(t, "bob").action(api.sources.bitbucket.testConnection, {
				gitProviderId,
				email: "bob@example.com",
			}),
		).rejects.toThrow(/gitProviders.create permission/);
		await expect(
			asUser(t, "mallory").action(api.sources.bitbucket.testConnection, {
				gitProviderId,
				email: "mallory@example.com",
				apiToken: "mallory-token",
			}),
		).rejects.toThrow(/Not a member/);
		expect(calls).toHaveLength(1);
	});
});

describe("OAuth callbacks", () => {
	test("callback URLs are on the Convex site and members only", async () => {
		const t = await seed();
		expect(
			await asUser(t, "bob").query(api.sources.providers.callbacks, {
				organizationId: "org1",
			}),
		).toEqual({
			githubSetup: "http://site.test/sources/github/setup",
			githubWebhook: "http://site.test/webhooks/github",
			gitlab: "http://site.test/sources/gitlab/callback",
			gitea: "http://site.test/sources/gitea/callback",
		});
		await expect(
			asUser(t, "mallory").query(api.sources.providers.callbacks, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("GitLab authorization stores encrypted tokens; state is single use", async () => {
		const t = await seed();
		const gitProviderId = await createGitlab(t);
		const authorizeUrl = new URL(
			await asUser(t, "alice").mutation(api.sources.gitlab.beginAuthorize, {
				gitProviderId,
			}),
		);
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
			"https://gitlab.example.com/oauth/authorize",
		);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
			"http://site.test/sources/gitlab/callback",
		);
		const state = authorizeUrl.searchParams.get("state") ?? "";

		const calls = mockFetch(() =>
			Response.json({
				access_token: ACCESS_TOKEN,
				refresh_token: REFRESH_TOKEN,
				expires_in: 7200,
			}),
		);
		const response = await t.fetch(
			`/sources/gitlab/callback?code=the-code&state=${encodeURIComponent(state)}`,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("connected=true");
		expect(calls[0]?.url).toBe("https://gitlab.example.com/oauth/token");
		const body = new URLSearchParams(String(calls[0]?.init?.body));
		expect(body.get("client_secret")).toBe(CLIENT_SECRET);
		expect(body.get("code")).toBe("the-code");

		const stored = await t.run(async (ctx) => ({
			provider: await ctx.db.get(
				"gitProviders",
				gitProviderId as Id<"gitProviders">,
			),
			secrets: await ctx.db.query("secrets").collect(),
			states: await ctx.db.query("oauthStates").collect(),
		}));
		expect(stored.provider?.connected).toBe(true);
		expect(JSON.stringify(stored)).not.toContain(ACCESS_TOKEN);
		expect(JSON.stringify(stored)).not.toContain(REFRESH_TOKEN);
		expect(stored.states).toEqual([]);

		const replay = await t.fetch(
			`/sources/gitlab/callback?code=again&state=${encodeURIComponent(state)}`,
		);
		expect(replay.headers.get("location")).toContain("error=");
		expect(calls).toHaveLength(1);
	});

	test("GitHub manifest and installation flow", async () => {
		const t = await seed();
		await expect(
			asUser(t, "bob").mutation(api.sources.github.beginManifest, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "alice").mutation(api.sources.github.beginManifest, {
				organizationId: "org1",
				githubUrl: "http://github.example.com",
			}),
		).rejects.toThrow(/Only https/);
		const { formAction, manifest } = await asUser(t, "alice").mutation(
			api.sources.github.beginManifest,
			{ organizationId: "org1", githubOrganization: "acme" },
		);
		const action = new URL(formAction);
		expect(action.pathname).toBe("/organizations/acme/settings/apps/new");
		expect(JSON.parse(manifest)).toMatchObject({
			redirect_url: "http://site.test/sources/github/setup",
			hook_attributes: { url: "http://site.test/webhooks/github" },
			default_events: ["pull_request", "push"],
		});

		const pem = openSshPrivateKey(
			{
				type: "ed25519",
				publicKey: new Uint8Array(32),
				seed: new Uint8Array(32),
			},
			"",
			1,
		);
		const calls = mockFetch(() =>
			Response.json({
				id: 123,
				name: "Panara Cloud-test",
				html_url: "https://github.com/apps/panara-cloud-test",
				client_id: "Iv1.abc",
				client_secret: "gh-client-secret",
				webhook_secret: "gh-webhook-secret",
				pem,
			}),
		);
		const setupResponse = await t.fetch(
			`/sources/github/setup?code=manifestcode&state=${encodeURIComponent(action.searchParams.get("state") ?? "")}`,
		);
		expect(setupResponse.headers.get("location")).not.toContain("error");
		expect(calls[0]?.url).toBe(
			"https://api.github.com/app-manifests/manifestcode/conversions",
		);
		const [provider] = await asUser(t, "alice").query(
			api.sources.providers.list,
			{
				organizationId: "org1",
				providerType: "github",
			},
		);
		expect(provider).toMatchObject({
			name: "Panara Cloud-test",
			connected: false,
			config: {
				appId: 123,
				appName: "https://github.com/apps/panara-cloud-test",
			},
		});
		const secretsDump = JSON.stringify(
			await t.run((ctx) => ctx.db.query("secrets").collect()),
		);
		expect(secretsDump).not.toContain("gh-client-secret");
		expect(secretsDump).not.toContain("OPENSSH");

		const installUrl = new URL(
			await asUser(t, "alice").mutation(api.sources.github.beginInstall, {
				gitProviderId: provider?._id as Id<"gitProviders">,
			}),
		);
		expect(installUrl.pathname).toBe(
			"/apps/panara-cloud-test/installations/new",
		);
		const installed = await t.fetch(
			`/sources/github/setup?installation_id=777&setup_action=install&state=${encodeURIComponent(installUrl.searchParams.get("state") ?? "")}`,
		);
		expect(installed.headers.get("location")).not.toContain("error");
		expect(
			await asUser(t, "alice").query(api.sources.providers.get, {
				gitProviderId: provider?._id as Id<"gitProviders">,
			}),
		).toMatchObject({ connected: true, config: { installationId: "777" } });

		const forged = await t.fetch(
			"/sources/github/setup?installation_id=1&state=made-up",
		);
		expect(forged.headers.get("location")).toContain("error=");
		expect(
			new URL(forged.headers.get("location") ?? "", "http://x").pathname,
		).toBe("/settings/git-providers");

		const gitProviderId = provider?._id as Id<"gitProviders">;
		await expect(
			asUser(t, "bob").mutation(api.sources.github.update, {
				gitProviderId,
				name: "x",
				appName: "https://github.com/apps/x",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "mallory").mutation(api.sources.github.update, {
				gitProviderId,
				name: "x",
				appName: "https://github.com/apps/x",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "alice").mutation(api.sources.github.update, {
				gitProviderId,
				name: "x",
				appName: "https://evil.example.com/apps/x",
			}),
		).rejects.toThrow(/App name must look like/);
		await asUser(t, "alice").mutation(api.sources.github.update, {
			gitProviderId,
			name: " Renamed ",
			appName: "https://github.com/apps/renamed-app/",
		});
		expect(
			await asUser(t, "alice").query(api.sources.providers.get, {
				gitProviderId,
			}),
		).toMatchObject({
			name: "Renamed",
			config: { appName: "https://github.com/apps/renamed-app", appId: 123 },
		});
	});

	test("expired states are rejected and cleaned up", async () => {
		vi.useFakeTimers();
		const t = await seed();
		const gitProviderId = await createGitlab(t);
		const url = new URL(
			await asUser(t, "alice").mutation(api.sources.gitlab.beginAuthorize, {
				gitProviderId,
			}),
		);
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		await t.mutation(internal.sources.oauthStates.cleanupExpired, {});
		expect(await t.run((ctx) => ctx.db.query("oauthStates").collect())).toEqual(
			[],
		);
		const consumed = await t.mutation(internal.sources.oauthStates.consume, {
			state: url.searchParams.get("state") ?? "",
			purposes: ["gitlab.authorize"],
		});
		expect(consumed).toBeNull();
	});
});
