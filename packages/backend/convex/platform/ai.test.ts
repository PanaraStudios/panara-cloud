import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";

const API_URL = "https://llm.example.com/v1";
const API_KEY = "sk-very-secret-key";

const createSetting = (t: TestConvex, user = "alice") =>
	asUser(t, user).action(api.platform.aiActions.create, {
		organizationId: "org1",
		name: "Primary",
		apiUrl: API_URL,
		apiKey: API_KEY,
		model: "gpt-test",
	});

const storedKey = async (t: TestConvex, aiId: string) =>
	(
		await asUser(t, "alice").query(internal.platform.ai.loadForAction, {
			aiId: aiId as never,
			action: "read",
		})
	).apiKey;

const mockModelsEndpoint = () => {
	const fetchMock = vi.fn(async (..._args: unknown[]) =>
		Response.json({
			data: [{ id: "gpt-test", object: "model", created: 1, owned_by: "x" }],
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ai settings", () => {
	test("the API key is encrypted, never listed, and masked on get", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "admin");
		const aiId = await createSetting(t);

		const stored = await t.run(async (ctx) => ({
			settings: await ctx.db.query("aiSettings").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		expect(stored.secrets).toMatchObject([
			{ kind: "platform.aiApiKey", ownerId: aiId },
		]);
		expect(JSON.stringify(stored)).not.toContain(API_KEY);

		const bob = asUser(t, "bob");
		const listed = await bob.query(api.platform.ai.list, {
			organizationId: "org1",
		});
		const one = await bob.query(api.platform.ai.get, { aiId });
		expect(one?.apiKey).toBe("********");
		expect(JSON.stringify([listed, one])).not.toContain(API_KEY);
		expect(
			await bob.query(api.platform.ai.getEnabledProviders, {
				organizationId: "org1",
			}),
		).toEqual([{ aiId, name: "Primary", model: "gpt-test" }]);

		await addMember(t, "org1", "mia", "member");
		await expect(
			asUser(t, "mia").query(api.platform.ai.list, { organizationId: "org1" }),
		).rejects.toThrow(/ai\.read permission/);
	});

	test("only admins write; other orgs can't read", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const aiId = await createSetting(t);

		await expect(createSetting(t, "bob")).rejects.toThrow(
			/Requires the [a-zA-Z]+\.[a-z]+ permission/,
		);
		await expect(
			asUser(t, "bob").action(api.platform.aiActions.update, {
				aiId,
				name: "x",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "bob").mutation(api.platform.ai.remove, { aiId }),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "bob").mutation(api.platform.ai.saveCustomProviders, {
				organizationId: "org1",
				providers: [],
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "mallory").query(api.platform.ai.get, { aiId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "mallory").action(api.platform.aiActions.analyzeLogs, {
				aiId,
				logs: "boom",
				context: "build",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("update keeps the stored key for a masked or missing key", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		const aiId = await createSetting(t);

		await alice.action(api.platform.aiActions.update, {
			aiId,
			apiKey: "********",
			model: "gpt-other",
		});
		await alice.action(api.platform.aiActions.update, {
			aiId,
			name: "Renamed",
		});
		expect(await storedKey(t, aiId)).toBe(API_KEY);
		expect(await alice.query(api.platform.ai.get, { aiId })).toMatchObject({
			name: "Renamed",
			model: "gpt-other",
		});

		await expect(
			alice.action(api.platform.aiActions.update, {
				aiId,
				apiUrl: "https://attacker.example.com/v1",
				apiKey: "********",
			}),
		).rejects.toThrow(/requires entering the API key again/);

		await alice.action(api.platform.aiActions.update, {
			aiId,
			apiUrl: "https://other.example.com/v1",
			apiKey: "sk-new",
		});
		expect(await storedKey(t, aiId)).toBe("sk-new");
	});

	test("custom providers restrict which API URLs can be configured", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		await alice.mutation(api.platform.ai.saveCustomProviders, {
			organizationId: "org1",
			providers: [
				{ name: "Internal", apiUrl: "https://llm.internal.example/v1/" },
			],
		});
		expect(
			await alice.query(api.platform.ai.getCustomProviders, {
				organizationId: "org1",
			}),
		).toEqual([
			{ name: "Internal", apiUrl: "https://llm.internal.example/v1/" },
		]);
		await expect(createSetting(t)).rejects.toThrow(/allowed AI providers/);
		await alice.action(api.platform.aiActions.create, {
			organizationId: "org1",
			name: "Internal",
			apiUrl: "https://llm.internal.example/v1",
			apiKey: "k",
			model: "m",
		});
	});

	test("listModels calls the provider's /models endpoint", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "admin");
		const fetchMock = mockModelsEndpoint();

		const models = await asUser(t, "bob").action(
			api.platform.aiActions.listModels,
			{ organizationId: "org1", apiUrl: API_URL, apiKey: "sk-typed" },
		);
		expect(models).toEqual([
			{ id: "gpt-test", object: "model", created: 1, owned_by: "x" },
		]);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${API_URL}/models`);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-typed",
		);
	});

	test("listModels with a masked key uses the stored key only for admins and the same URL", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const aiId = await createSetting(t);
		const fetchMock = mockModelsEndpoint();

		await expect(
			asUser(t, "bob").action(api.platform.aiActions.listModels, {
				organizationId: "org1",
				apiUrl: API_URL,
				apiKey: "********",
				aiId,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "alice").action(api.platform.aiActions.listModels, {
				organizationId: "org1",
				apiUrl: "https://attacker.example.com/v1",
				apiKey: "********",
				aiId,
			}),
		).rejects.toThrow(/does not match/);
		expect(fetchMock).not.toHaveBeenCalled();

		await asUser(t, "alice").action(api.platform.aiActions.listModels, {
			organizationId: "org1",
			apiUrl: `${API_URL}/`,
			apiKey: "********",
			aiId,
		});
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${API_KEY}`,
		);
	});

	test("analyzeLogs refuses disabled providers", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const aiId = await createSetting(t);
		await asUser(t, "alice").action(api.platform.aiActions.update, {
			aiId,
			isEnabled: false,
		});
		await expect(
			asUser(t, "alice").action(api.platform.aiActions.analyzeLogs, {
				aiId,
				logs: "error",
				context: "runtime",
			}),
		).rejects.toThrow(/not enabled/);
	});

	test("analyzeLogs and suggest run through the AI SDK with the stored key", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "admin");
		const aiId = await createSetting(t);
		const completion = (content: string) =>
			Response.json({
				id: "c1",
				object: "chat.completion",
				created: 1,
				model: "gpt-test",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		const suggestion = {
			id: "ghost",
			name: "Ghost",
			shortDescription: "Blog",
			description: "Ghost blog",
			dockerCompose: "services:\n  ghost:\n    image: ghost:5",
			envVariables: [],
			domains: [
				{ host: "ghost.example.com", port: 2368, serviceName: "ghost" },
			],
			configFiles: null,
		};
		const fetchMock = vi
			.fn(async (..._args: unknown[]) => completion("Logs look healthy."))
			.mockResolvedValueOnce(completion("Logs look healthy."))
			.mockResolvedValueOnce(
				completion(JSON.stringify({ suggestions: [suggestion] })),
			);
		vi.stubGlobal("fetch", fetchMock);

		const bob = asUser(t, "bob");
		expect(
			await bob.action(api.platform.aiActions.analyzeLogs, {
				aiId,
				logs: "GET / 200",
				context: "runtime",
			}),
		).toEqual({ analysis: "Logs look healthy." });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${API_URL}/chat/completions`);
		expect(new Headers(init.headers).get("authorization")).toBe(
			`Bearer ${API_KEY}`,
		);

		expect(
			await bob.action(api.platform.aiActions.suggest, {
				aiId,
				input: "a blog",
			}),
		).toEqual([suggestion]);
	});
});
