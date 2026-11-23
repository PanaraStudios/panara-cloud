import { makeFunctionReference } from "convex/server";
import { ConvexError, convexToJson, jsonToConvex } from "convex/values";
import {
	exportJWK,
	exportPKCS8,
	generateKeyPair,
	type JWK,
	jwtVerify,
} from "jose";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	asUser,
	SITE_URL,
	setup,
	type TestConvex,
} from "../test.setup";
import {
	API_KEY_AUDIENCE,
	functionApiUrls,
	rejectionStatus,
} from "./lib/apiGateway";

const KEY_ID = "test-key";
let publicJwk: JWK;

beforeAll(async () => {
	const { privateKey, publicKey } = await generateKeyPair("ES256", {
		extractable: true,
	});
	process.env.AGENT_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
	process.env.AGENT_JWT_KID = KEY_ID;
	publicJwk = await exportJWK(publicKey);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete process.env.CONVEX_CLOUD_URL;
	delete process.env.PANARA_CLOUD_FUNCTION_API_URL;
});

type Call = { url: string; path: string; claims: Record<string, unknown> };

// Stands in for the deployment's function API: checks the gateway's token
// the way Convex would (signature, issuer, audience) and runs the function
// under the identity it carries.
const serveFunctionApi = (t: TestConvex) => {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		const { payload, protectedHeader } = await jwtVerify(token, publicJwk, {
			issuer: `${SITE_URL}/api-key`,
			audience: API_KEY_AUDIENCE,
		});
		expect(protectedHeader).toMatchObject({ alg: "ES256", kid: KEY_ID });
		const body = JSON.parse(String(init.body));
		expect(body.format).toBe("convex_encoded_json");
		calls.push({ url: input, path: body.path, claims: payload });
		const identity = t.withIdentity({
			subject: payload.sub,
			issuer: payload.iss,
			organizationId: payload.organizationId as string,
			apiKeyId: payload.apiKeyId as string,
		});
		const kind = new URL(input).pathname.split("/").at(-1);
		const args = jsonToConvex(body.args[0]) as Record<string, unknown>;
		try {
			const value =
				kind === "query"
					? await identity.query(
							makeFunctionReference<"query">(body.path),
							args,
						)
					: kind === "mutation"
						? await identity.mutation(
								makeFunctionReference<"mutation">(body.path),
								args,
							)
						: await identity.action(
								makeFunctionReference<"action">(body.path),
								args,
							);
			return Response.json({
				status: "success",
				value: convexToJson(value === undefined ? null : value),
			});
		} catch (error) {
			return Response.json(
				error instanceof ConvexError
					? {
							status: "error",
							errorMessage: `Uncaught ConvexError: ${JSON.stringify(error.data)}`,
							errorData: convexToJson(error.data),
						}
					: {
							status: "error",
							errorMessage: `Uncaught ${String(error)}\n    at handler (../convex/secret.ts:1:1)`,
						},
				{ status: 560 },
			);
		}
	});
	return calls;
};

const respondWith = (status: number, body: unknown) =>
	vi.stubGlobal("fetch", async () => Response.json(body, { status }));

const seed = async () => {
	const t = setup();
	await addMember(t, "org-a", "alice", "owner");
	await addMember(t, "org-b", "alice", "owner");
	const { key, apiKeyId } = await asUser(t, "alice").action(
		api.platform.apiKeys.create,
		{ organizationId: "org-a", name: "ci" },
	);
	return { t, key, apiKeyId };
};

const post = (
	t: TestConvex,
	name: string,
	key: string | null,
	body?: unknown,
) =>
	t.fetch(`/api/v1/call/${name}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(key ? { "x-api-key": key } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const get = (t: TestConvex, name: string, key: string, args?: unknown) =>
	t.fetch(
		`/api/v1/call/${name}${args === undefined ? "" : `?args=${encodeURIComponent(JSON.stringify(args))}`}`,
		{ method: "GET", headers: { Authorization: `Bearer ${key}` } },
	);

describe("API gateway", () => {
	test("runs a mutation, a query and an action as the key's user", async () => {
		const { t, key, apiKeyId } = await seed();
		const calls = serveFunctionApi(t);

		const created = await post(t, "projects.create", key, {
			organizationId: "org-a",
			name: "shop",
		});
		expect(created.status).toBe(200);
		const { data } = (await created.json()) as { data: { projectId: string } };
		expect(data.projectId).toEqual(expect.any(String));

		const listed = await get(t, "projects.list", key, {
			organizationId: "org-a",
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ data: [{ name: "shop" }] });

		const action = await post(t, "sshKeys.create", key, {
			organizationId: "org-a",
			name: "deploy",
			publicKey: "ssh-ed25519 AAAAC3Nza test",
			privateKey:
				"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
		});
		expect(action.status).toBe(200);

		expect(calls.map((call) => call.path)).toEqual([
			"projects:create",
			"projects:list",
			"sshKeys:create",
		]);
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/api/mutation",
			"/api/query",
			"/api/action",
		]);
		for (const call of calls) {
			expect(call.claims).toMatchObject({
				sub: "alice",
				organizationId: "org-a",
				apiKeyId,
			});
			const lifetime =
				(call.claims.exp as number) - (call.claims.iat as number);
			expect(lifetime).toBeGreaterThan(600);
			expect(lifetime).toBeLessThan(900);
		}
	});

	test("records the key's usage on every call", async () => {
		const { t, key, apiKeyId } = await seed();
		serveFunctionApi(t);
		expect(
			(await t.run((ctx) => ctx.db.get("apiKeys", apiKeyId)))?.lastUsedAt,
		).toBeUndefined();
		await get(t, "projects.list", key, { organizationId: "org-a" });
		expect(
			(await t.run((ctx) => ctx.db.get("apiKeys", apiKeyId)))?.lastUsedAt,
		).toEqual(expect.any(Number));
	});

	test("a key cannot reach another organization of its user", async () => {
		const { t, key } = await seed();
		serveFunctionApi(t);
		const { projectId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org-b", name: "other" },
		);

		const read = await get(t, "projects.list", key, {
			organizationId: "org-b",
		});
		expect(read.status).toBe(403);
		expect(await read.json()).toEqual({
			error: "This API key belongs to another organization",
		});

		const write = await post(t, "projects.update", key, {
			projectId,
			name: "taken",
		});
		expect(write.status).toBe(403);
		const remove = await post(t, "projects.remove", key, { projectId });
		expect(remove.status).toBe(403);
		expect(
			await asUser(t, "alice").query(api.projects.list, {
				organizationId: "org-b",
			}),
		).toMatchObject([{ name: "other" }]);
	});

	test("401 without a valid key, before anything else is looked at", async () => {
		const { t } = await seed();
		const calls = serveFunctionApi(t);
		const missing = await post(t, "projects.list", null, {});
		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({
			error: "Missing or malformed API key",
		});
		const wrong = await post(t, "no.such", "pnr_0123456789abcdef0123", {});
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: "Invalid API key" });
		expect(calls).toEqual([]);
	});

	test("unknown functions are 404 and denied ones 403, without a call", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		for (const name of [
			"no.such",
			"projects.nope",
			"platform.apiKeys.insert",
			"users.provision",
			"constructor",
			"__proto__",
			"",
		]) {
			const response = await post(t, name, key, {});
			expect(response.status, name).toBe(404);
		}
		for (const name of [
			"platform.apiKeys.create",
			"platform.apiKeys.revoke",
			"account.changeEmailWithoutConfirmation",
			"account.revokeOtherSessions",
			"agent.claimNext",
			"sources.github.beginInstall",
			"live.sessions.open",
			"users.createWithCredentials",
			"users.invite",
			"users.passwordResetLink",
			"users.setDeactivated",
			"users.removeAccount",
			"account.removeInvitation",
			"permissions.assign",
		]) {
			const response = await post(t, name, key, {});
			expect(response.status, name).toBe(403);
			expect(((await response.json()) as { error: string }).error).toContain(
				"is not available with an API key",
			);
		}
		expect(calls).toEqual([]);
	});

	test("GET serves queries only", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		const response = await get(t, "projects.create", key, {
			organizationId: "org-a",
			name: "x",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
		expect(calls).toEqual([]);
	});

	test("400 for arguments that are not a JSON object", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		const send = (body: string) =>
			t.fetch("/api/v1/call/projects.list", {
				method: "POST",
				headers: { "x-api-key": key },
				body,
			});
		for (const body of ["{not json", "[]", '"text"', "null", "42"]) {
			const response = await send(body);
			expect(response.status, body).toBe(400);
			expect(await response.json()).toEqual({
				error: "Arguments must be a JSON object",
			});
		}
		const badEncoding = await send('{"size":{"$integer":"not base64!"}}');
		expect(badEncoding.status).toBe(400);
		const badQuery = await t.fetch("/api/v1/call/projects.list?args=%7B", {
			method: "GET",
			headers: { "x-api-key": key },
		});
		expect(badQuery.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("arguments are checked before the call, so a backend that redacts its errors still answers 400", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		const { environmentId } = await asUser(t, "alice").mutation(
			api.projects.create,
			{ organizationId: "org-a", name: "shop" },
		);
		const cases: [string, unknown, string][] = [
			[
				"projects.create",
				{ organizationId: "org-a", name: 5 },
				"Invalid arguments: Value does not match validator. Path: .name",
			],
			[
				"projects.create",
				{ organizationId: "org-a" },
				"Invalid arguments: Object is missing the required field `name`.",
			],
			[
				"projects.create",
				{ organizationId: "org-a", name: "x", extra: true },
				"Invalid arguments: Object contains extra field `extra` that is not in the validator.",
			],
			[
				"projects.remove",
				{ projectId: "nope" },
				"Invalid arguments: Value does not match validator. Path: .projectId (an id of projects)",
			],
			[
				"projects.remove",
				{ projectId: environmentId },
				"Invalid arguments: Value does not match validator. Path: .projectId (an id of projects)",
			],
		];
		for (const [name, body, error] of cases) {
			const response = await post(t, name, key, body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json()).toEqual({ error });
		}
		expect(calls).toEqual([]);
		expect(
			(
				await post(t, "projects.create", key, {
					organizationId: "org-a",
					name: "ok",
				})
			).status,
		).toBe(200);
	});

	test("no answer may be cached, and arguments over 4 MB are refused unread", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		const answers = [
			await post(t, "projects.create", key, {
				organizationId: "org-a",
				name: "shop",
			}),
			await get(t, "projects.list", key, { organizationId: "org-a" }),
			await post(t, "projects.list", null, {}),
			await post(t, "platform.apiKeys.create", key, {}),
			await t.fetch("/api/v1/me", { headers: { "x-api-key": key } }),
		];
		for (const answer of answers) {
			expect(answer.headers.get("Cache-Control")).toBe("no-store");
		}
		const large = await post(t, "projects.create", key, {
			organizationId: "org-a",
			name: "x".repeat(4 * 1024 * 1024),
		});
		expect(large.status).toBe(413);
		expect(await large.json()).toEqual({
			error: "Arguments are larger than 4 MB",
		});
		expect(calls.map((call) => call.path)).toEqual([
			"projects:create",
			"projects:list",
		]);
	});

	test("an empty body means no arguments", async () => {
		const { t, key } = await seed();
		const calls = serveFunctionApi(t);
		const response = await post(t, "platform.settings.serverTime", key);
		expect(calls.map((call) => call.path)).toEqual([
			"platform/settings:serverTime",
		]);
		expect([200, 400, 403]).toContain(response.status);
	});

	test("the key's rate limit and usage limit apply, with Retry-After", async () => {
		const t = setup();
		await addMember(t, "org-a", "alice", "owner");
		serveFunctionApi(t);
		const limited = await asUser(t, "alice").action(
			api.platform.apiKeys.create,
			{
				organizationId: "org-a",
				name: "limited",
				rateLimit: { timeWindowMs: 60_000, max: 2 },
			},
		);
		const call = (key: string) =>
			get(t, "projects.list", key, { organizationId: "org-a" });
		expect((await call(limited.key)).status).toBe(200);
		expect((await call(limited.key)).status).toBe(200);
		const refused = await call(limited.key);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "Rate limit exceeded" });
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
		// Denied and unknown functions count too.
		expect((await post(t, "no.such", limited.key, {})).status).toBe(429);

		const metered = await asUser(t, "alice").action(
			api.platform.apiKeys.create,
			{
				organizationId: "org-a",
				name: "metered",
				requestLimit: { remaining: 1 },
			},
		);
		expect((await call(metered.key)).status).toBe(200);
		const spent = await call(metered.key);
		expect(spent.status).toBe(429);
		expect(await spent.json()).toEqual({ error: "Usage limit exceeded" });
	});

	test("rejections keep their message; failures never leak", async () => {
		const { t, key } = await seed();
		serveFunctionApi(t);
		const rejected = await post(t, "projects.create", key, {
			organizationId: "org-a",
			name: "   ",
		});
		expect(rejected.status).toBe(400);
		expect(
			((await rejected.json()) as { error: string }).error.length,
		).toBeGreaterThan(3);

		const missing = await post(t, "projects.update", key, {
			projectId: "99999;projects",
			name: "x",
		});
		expect([400, 404, 500]).toContain(missing.status);

		respondWith(560, {
			status: "error",
			errorMessage:
				"[Request ID: abc] Server Error\nUncaught Error: connect ECONNREFUSED postgres://admin:hunter2@db\n    at handler (../convex/projects.ts:10:2)",
		});
		const failed = await post(t, "projects.list", key, {
			organizationId: "org-a",
		});
		expect(failed.status).toBe(500);
		expect(await failed.text()).toBe('{"error":"Internal error"}');

		respondWith(560, {
			status: "error",
			errorMessage:
				"[Request ID: abc] Server Error\nArgumentValidationError: Object is missing the required field `organizationId`. Consider wrapping the field validator in `v.optional(...)` if this is expected.\n\nObject: {}\nValidator: v.object({organizationId: v.string()})",
		});
		const invalid = await post(t, "projects.list", key, {});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({
			error:
				"Invalid arguments: Object is missing the required field `organizationId`.",
		});

		respondWith(560, {
			status: "error",
			errorMessage: "Uncaught ConvexError",
			errorData: { code: "quota", limit: 3 },
		});
		const structured = await post(t, "projects.list", key, {
			organizationId: "org-a",
		});
		expect(structured.status).toBe(400);
		expect(await structured.json()).toEqual({
			error: "Request rejected",
			data: { code: "quota", limit: 3 },
		});

		respondWith(401, { code: "Unauthenticated", message: "token rejected" });
		const upstream = await post(t, "projects.list", key, {
			organizationId: "org-a",
		});
		expect(upstream.status).toBe(500);
		expect(await upstream.json()).toEqual({ error: "Internal error" });
	});

	test("503 while the signing key is not set", async () => {
		const { t, key } = await seed();
		serveFunctionApi(t);
		const saved = process.env.AGENT_JWT_PRIVATE_KEY;
		delete process.env.AGENT_JWT_PRIVATE_KEY;
		try {
			const response = await post(t, "projects.list", key, {
				organizationId: "org-a",
			});
			expect(response.status).toBe(503);
		} finally {
			process.env.AGENT_JWT_PRIVATE_KEY = saved;
		}
	});

	test("502 when the backend cannot be reached, trying the next address only if the first is down", async () => {
		const { t, key } = await seed();
		process.env.CONVEX_CLOUD_URL = "https://panel.example.test/convex";
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (input: string) => {
			seen.push(input);
			throw new TypeError("fetch failed");
		});
		const response = await post(t, "projects.list", key, {
			organizationId: "org-a",
		});
		expect(response.status).toBe(502);
		expect(seen).toEqual([
			"http://127.0.0.1:3210/api/query",
			"http://127.0.0.1:3210/version",
			"https://panel.example.test/convex/api/query",
		]);

		// The first address is alive, so the failed call may have run: no retry.
		seen.length = 0;
		vi.stubGlobal("fetch", async (input: string) => {
			seen.push(input);
			if (input.endsWith("/version")) return new Response("1");
			throw new TypeError("socket hang up");
		});
		const midway = await post(t, "projects.create", key, {
			organizationId: "org-a",
			name: "x",
		});
		expect(midway.status).toBe(502);
		expect(seen).toEqual([
			"http://127.0.0.1:3210/api/mutation",
			"http://127.0.0.1:3210/version",
		]);
	});
});

describe("where the gateway calls functions", () => {
	test("a local backend's own address, else loopback first", () => {
		delete process.env.CONVEX_CLOUD_URL;
		expect(functionApiUrls()).toEqual(["http://127.0.0.1:3210"]);
		process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3990";
		expect(functionApiUrls()).toEqual(["http://127.0.0.1:3990"]);
		process.env.CONVEX_CLOUD_URL = "https://panel.example.test/convex";
		expect(functionApiUrls()).toEqual([
			"http://127.0.0.1:3210",
			"https://panel.example.test/convex",
		]);
		process.env.PANARA_CLOUD_FUNCTION_API_URL = "http://convex:3210";
		expect(functionApiUrls()).toEqual(["http://convex:3210"]);
	});
});

describe("status of a rejection", () => {
	test("is read off the message", () => {
		expect(rejectionStatus("Requires the admin role")).toBe(403);
		expect(rejectionStatus("Requires the project.create permission")).toBe(403);
		expect(rejectionStatus("Not a member of this organization")).toBe(403);
		expect(rejectionStatus("You don't have access to this project")).toBe(403);
		expect(rejectionStatus("Requires an instance administrator")).toBe(403);
		expect(
			rejectionStatus("This API key belongs to another organization"),
		).toBe(403);
		expect(rejectionStatus("Not available with an API key")).toBe(403);
		expect(rejectionStatus("Project not found")).toBe(404);
		expect(rejectionStatus("Not authenticated")).toBe(401);
		expect(rejectionStatus("Name is required")).toBe(400);
	});
});
