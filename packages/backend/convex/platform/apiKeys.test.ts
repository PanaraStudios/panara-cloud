import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { sha256Hex } from "../lib/crypto";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

afterEach(() => {
	vi.useRealTimers();
	delete process.env.API_RATE_LIMIT_PER_MINUTE;
});

const createKey = async (
	t: TestConvex,
	userId = "alice",
	organizationId = "org1",
	expiresAt?: number,
) =>
	await asUser(t, userId).action(api.platform.apiKeys.create, {
		organizationId,
		name: "ci",
		expiresAt,
	});

// Members need the "Access to API/CLI" grant for API keys.
const addApiMember = async (
	t: TestConvex,
	organizationId: string,
	userId: string,
) => {
	await addMember(t, organizationId, userId, "member");
	await grantMember(t, organizationId, userId, {
		flags: { canAccessToAPI: true },
	});
};

const get = (t: TestConvex, path: string, key?: string) =>
	t.fetch(path, {
		method: "GET",
		headers: key ? { "x-api-key": key } : {},
	});

describe("api keys", () => {
	test("members need the API grant to create and use keys", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "olivia", "owner");
		await expect(createKey(t)).rejects.toThrow(/api\.read permission/);
		await expect(createKey(t, "olivia")).resolves.toMatchObject({
			key: expect.stringMatching(/^pnr_/),
		});
		await grantMember(t, "org1", "alice", { flags: { canAccessToAPI: true } });
		const { key } = await createKey(t);
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		await grantMember(t, "org1", "alice", { flags: { canAccessToAPI: false } });
		const refused = await get(t, "/api/v1/me", key);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({
			error: "API key owner has no access to the API",
		});
	});

	test("keys are stored hashed and listed without secrets", async () => {
		const t = setup();
		await addApiMember(t, "org1", "alice");
		const { key, prefix, apiKeyId } = await createKey(t);
		expect(key).toMatch(/^pnr_[A-Za-z0-9_-]{43}$/);
		expect(key.startsWith(prefix)).toBe(true);

		const stored = await t.run((ctx) => ctx.db.get("apiKeys", apiKeyId));
		expect(stored?.hash).toBe(await sha256Hex(key));
		expect(JSON.stringify(stored)).not.toContain(key);

		const listed = await asUser(t, "alice").query(api.platform.apiKeys.list, {
			organizationId: "org1",
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: "ci", prefix });
		expect(listed[0]).not.toHaveProperty("hash");
		expect(JSON.stringify(listed)).not.toContain(key);
	});

	test("non-members and members without api access cannot create keys; users only see their own", async () => {
		const t = setup();
		await addApiMember(t, "org1", "alice");
		await addApiMember(t, "org1", "bob");
		await addMember(t, "org1", "mia", "member");
		await expect(createKey(t, "mallory")).rejects.toThrow(/Not a member/);
		await expect(createKey(t, "mia")).rejects.toThrow(/api\.read/);
		await createKey(t, "alice");
		expect(
			await asUser(t, "bob").query(api.platform.apiKeys.list, {
				organizationId: "org1",
			}),
		).toHaveLength(0);
	});

	test("a member's key only sees the projects they were given", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addApiMember(t, "org1", "bob");
		const alice = asUser(t, "alice");
		const { projectId: shared } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shared",
		});
		const { projectId: hidden } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Hidden",
		});
		await grantMember(t, "org1", "bob", { projects: [shared] });
		const { key } = await createKey(t, "bob");
		const list = await (await get(t, "/api/v1/projects", key)).json();
		expect(list.data.map((p: { name: string }) => p.name)).toEqual(["Shared"]);
		expect((await get(t, `/api/v1/projects/${hidden}`, key)).status).toBe(404);
		expect((await get(t, `/api/v1/projects/${shared}`, key)).status).toBe(200);
		const { key: adminKey } = await createKey(t);
		const all = await (await get(t, "/api/v1/projects", adminKey)).json();
		expect(all.data).toHaveLength(2);
	});

	test("authenticates REST requests and scopes data to the key's org", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org2", "mallory", "owner");
		const { projectId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		const { projectId: otherProject } = await asUser(t, "mallory").mutation(
			api.projects.create,
			{ organizationId: "org2", name: "Secret" },
		);
		const { key } = await createKey(t);

		const me = await get(t, "/api/v1/me", key);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({
			userId: "alice",
			organizationId: "org1",
			role: "admin",
		});

		const bearer = await t.fetch("/api/v1/projects", {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(bearer.status).toBe(200);
		const { data } = await bearer.json();
		expect(data.map((p: { name: string }) => p.name)).toEqual(["Shop"]);

		const one = await get(t, `/api/v1/projects/${projectId}`, key);
		expect(await one.json()).toMatchObject({
			data: { name: "Shop", environments: [{ name: "production" }] },
		});
		expect((await get(t, `/api/v1/projects/${otherProject}`, key)).status).toBe(
			404,
		);
		expect((await get(t, "/api/v1/projects/garbage", key)).status).toBe(404);

		expect((await get(t, "/api/v1/me")).status).toBe(401);
		expect((await get(t, "/api/v1/me", "pnr_wrong")).status).toBe(401);
		expect((await get(t, "/api/v1/me", "not-a-key")).status).toBe(401);
		const lastUsed = await t.run(
			async (ctx) => (await ctx.db.query("apiKeys").first())?.lastUsedAt,
		);
		expect(lastUsed).toBeTypeOf("number");
	});

	test("member keys only reach granted projects and environments", async () => {
		const t = setup();
		await addMember(t, "org1", "olivia", "owner");
		await addApiMember(t, "org1", "alice");
		const shop = await asUser(t, "olivia").mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const hidden = await asUser(t, "olivia").mutation(api.projects.create, {
			organizationId: "org1",
			name: "Hidden",
		});
		await grantMember(t, "org1", "alice", { projects: [shop.projectId] });
		const { key } = await createKey(t);

		const list = await get(t, "/api/v1/projects", key);
		expect(
			(await list.json()).data.map((p: { name: string }) => p.name),
		).toEqual(["Shop"]);
		expect(
			(await get(t, `/api/v1/projects/${hidden.projectId}`, key)).status,
		).toBe(404);
		const one = await get(t, `/api/v1/projects/${shop.projectId}`, key);
		expect((await one.json()).data.environments).toEqual([]);

		await grantMember(t, "org1", "alice", {
			environments: [shop.environmentId],
		});
		const granted = await get(t, `/api/v1/projects/${shop.projectId}`, key);
		expect((await granted.json()).data.environments).toMatchObject([
			{ name: "production" },
		]);
	});

	test("expired, revoked and orphaned keys are rejected", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addApiMember(t, "org1", "alice");
		await addApiMember(t, "org1", "bob");
		await addMember(t, "org1", "carl", "admin");
		await addMember(t, "org1", "olivia", "owner");
		const expiring = await createKey(t, "alice", "org1", Date.now() + 60_000);
		expect((await get(t, "/api/v1/me", expiring.key)).status).toBe(200);
		vi.setSystemTime(Date.now() + 61_000);
		const expired = await get(t, "/api/v1/me", expiring.key);
		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ error: "API key expired" });

		const revoked = await createKey(t);
		await expect(
			asUser(t, "bob").mutation(api.platform.apiKeys.revoke, {
				apiKeyId: revoked.apiKeyId,
			}),
		).rejects.toThrow(/admin role/);
		await asUser(t, "olivia").mutation(api.platform.apiKeys.revoke, {
			apiKeyId: revoked.apiKeyId,
		});
		expect((await get(t, "/api/v1/me", revoked.key)).status).toBe(401);

		const orphaned = await createKey(t, "carl");
		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("memberships")
				.withIndex("by_organizationId_and_userId", (q) =>
					q.eq("organizationId", "org1").eq("userId", "carl"),
				)
				.unique();
			if (membership) await ctx.db.delete("memberships", membership._id);
		});
		expect((await get(t, "/api/v1/me", orphaned.key)).status).toBe(403);
	});

	test("rate limits each key per minute", async () => {
		vi.useFakeTimers();
		process.env.API_RATE_LIMIT_PER_MINUTE = "3";
		const t = setup();
		await addApiMember(t, "org1", "alice");
		const { key } = await createKey(t);
		const other = await createKey(t);
		for (let i = 0; i < 3; i++) {
			expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		}
		const limited = await get(t, "/api/v1/me", key);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect((await get(t, "/api/v1/me", other.key)).status).toBe(200);
		vi.setSystemTime(Date.now() + 61_000);
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
	});
});

describe("api key prefixes and limits", () => {
	const create = (
		t: TestConvex,
		extra: Record<string, unknown> = {},
		userId = "alice",
	) =>
		asUser(t, userId).action(api.platform.apiKeys.create, {
			organizationId: "org1",
			name: "ci",
			...extra,
		});

	test("a custom prefix starts the key and authenticates", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const { key, prefix } = await create(t, { prefix: "my_app-" });
		expect(key).toMatch(/^my_app-[A-Za-z0-9_-]{43}$/);
		expect(prefix).toBe(key.slice(0, "my_app-".length + 8));
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		for (const bad of ["has space", "x".repeat(33), "dots.no"]) {
			await expect(create(t, { prefix: bad })).rejects.toThrow(/Prefix/);
		}
	});

	test("rejects out-of-range limits", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await expect(
			create(t, { rateLimit: { timeWindowMs: 10, max: 5 } }),
		).rejects.toThrow(/Time window/);
		await expect(
			create(t, { rateLimit: { timeWindowMs: 60_000, max: 0 } }),
		).rejects.toThrow(/Maximum requests/);
		await expect(
			create(t, { requestLimit: { remaining: 5, refillAmount: 5 } }),
		).rejects.toThrow(/together/);
	});

	test("a per-key rate limit replaces the instance default", async () => {
		vi.useFakeTimers();
		process.env.API_RATE_LIMIT_PER_MINUTE = "100";
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const { key } = await create(t, {
			rateLimit: { timeWindowMs: 5 * 60_000, max: 2 },
		});
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		const limited = await get(t, "/api/v1/me", key);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(60);
		vi.setSystemTime(Date.now() + 2 * 60_000);
		expect((await get(t, "/api/v1/me", key)).status).toBe(429);
		vi.setSystemTime(Date.now() + 3 * 60_000 + 1000);
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
	});

	test("the request quota is consumed and refilled after its interval", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const { key } = await create(t, {
			requestLimit: {
				remaining: 2,
				refillAmount: 3,
				refillIntervalMs: 60 * 60_000,
			},
		});
		const once = await create(t, { requestLimit: { remaining: 1 } });
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		const exhausted = await get(t, "/api/v1/me", key);
		expect(exhausted.status).toBe(429);
		expect(await exhausted.json()).toEqual({ error: "Usage limit exceeded" });

		vi.setSystemTime(Date.now() + 60 * 60_000 + 1000);
		for (let i = 0; i < 3; i++) {
			expect((await get(t, "/api/v1/me", key)).status).toBe(200);
		}
		expect((await get(t, "/api/v1/me", key)).status).toBe(429);

		expect((await get(t, "/api/v1/me", once.key)).status).toBe(200);
		expect((await get(t, "/api/v1/me", once.key)).status).toBe(429);
	});
});

describe("api keys across organizations", () => {
	test("listMine returns the caller's keys in every organization they belong to", async () => {
		const t = setup();
		await addApiMember(t, "org1", "alice");
		await addMember(t, "org2", "alice", "admin");
		await addMember(t, "org1", "bob", "owner");
		await createKey(t, "alice", "org1");
		await createKey(t, "alice", "org2");
		await createKey(t, "bob", "org1");

		const mine = await asUser(t, "alice").query(
			api.platform.apiKeys.listMine,
			{},
		);
		expect(mine.map((k) => k.organizationId).sort()).toEqual(["org1", "org2"]);
		expect(mine[0]).not.toHaveProperty("hash");
		await expect(t.query(api.platform.apiKeys.listMine, {})).rejects.toThrow(
			/Not authenticated/,
		);
	});
});
