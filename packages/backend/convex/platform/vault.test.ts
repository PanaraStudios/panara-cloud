import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";

const TOKEN = "hvs.super-secret-token";

const hashicorpConfig = {
	url: "https://vault.example.com",
	token: TOKEN,
};

type Handler = (url: string, init: RequestInit) => Response | undefined;

const mockFetch = (handler: Handler) => {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({ url, init });
			return handler(url, init) ?? new Response("not found", { status: 404 });
		}),
	);
	return calls;
};

const hashicorpVault = (secrets: Record<string, Record<string, string>>) =>
	mockFetch((url, init) => {
		const headers = init.headers as Record<string, string>;
		if (headers["X-Vault-Token"] !== TOKEN) {
			return new Response("forbidden", { status: 403 });
		}
		const match = /\/v1\/secret\/data\/(.+)$/.exec(url);
		const data = match ? secrets[decodeURIComponent(match[1] as string)] : null;
		return data ? Response.json({ data: { data } }) : undefined;
	});

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org1", name: "Shop" },
	);
	const vaultProviderId = await alice.action(api.platform.vaultActions.create, {
		organizationId: "org1",
		name: "main",
		providerType: "hashicorp",
		config: hashicorpConfig,
		assignments: [{ projectId, environmentIds: [] }],
	});
	return { alice, projectId, environmentId, vaultProviderId };
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vault providers", () => {
	test("credentials are encrypted and masked in reads", async () => {
		const t = setup();
		const { alice } = await seed(t);
		const docs = await t.run(async (ctx) => ({
			providers: await ctx.db.query("vaultProviders").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		expect(JSON.stringify(docs)).not.toContain(TOKEN);
		expect(docs.secrets).toMatchObject([{ kind: "platform.vaultProvider" }]);

		const list = await alice.query(api.platform.vault.list, {
			organizationId: "org1",
		});
		expect(list).toMatchObject([
			{
				name: "main",
				config: {
					url: "https://vault.example.com",
					mount: "secret",
					token: "********",
				},
			},
		]);
		expect(JSON.stringify(list)).not.toContain(TOKEN);
	});

	test("members read, admins write, other orgs and anonymous are denied", async () => {
		const t = setup();
		const { vaultProviderId, projectId } = await seed(t);
		const bob = asUser(t, "bob");
		await expect(
			bob.query(api.platform.vault.get, { vaultProviderId }),
		).resolves.toMatchObject({ name: "main" });
		await expect(
			bob.action(api.platform.vaultActions.create, {
				organizationId: "org1",
				name: "other",
				providerType: "doppler",
				config: { serviceToken: "dp.st.x" },
				assignments: [],
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			bob.mutation(api.platform.vault.remove, { vaultProviderId }),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			bob.action(api.platform.vaultActions.testConnection, {
				organizationId: "org1",
				vaultProviderId,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);

		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.platform.vault.get, { vaultProviderId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.action(api.platform.vaultActions.listSecretNames, {
				vaultProviderId,
				projectId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.query(api.platform.vault.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not authenticated/);
	});

	test("rejects invalid names, duplicates and foreign assignments", async () => {
		const t = setup();
		const { alice } = await seed(t);
		const { projectId: foreignProject } = await asUser(t, "mallory").mutation(
			api.projects.create,
			{ organizationId: "org2", name: "Theirs" },
		);
		const create = (name: string, projectId = foreignProject) =>
			alice.action(api.platform.vaultActions.create, {
				organizationId: "org1",
				name,
				providerType: "hashicorp",
				config: hashicorpConfig,
				assignments: [{ projectId, environmentIds: [] }],
			});
		await expect(create("other")).rejects.toThrow(/outside this organization/);
		await expect(create("main")).rejects.toThrow(/already exists/);
		await expect(create("has space")).rejects.toThrow(/letters, numbers/);
		await expect(
			alice.action(api.platform.vaultActions.create, {
				organizationId: "org1",
				name: "bad",
				providerType: "hashicorp",
				config: { url: "not a url", token: "x" },
				assignments: [],
			}),
		).rejects.toThrow(/valid URL/);
	});

	test("masked credentials are kept on update unless the connection changes", async () => {
		const t = setup();
		const { alice, vaultProviderId, projectId } = await seed(t);
		const masked = { url: "https://vault.example.com", token: "********" };
		await alice.action(api.platform.vaultActions.update, {
			vaultProviderId,
			name: "renamed",
			providerType: "hashicorp",
			config: masked,
			assignments: [{ projectId, environmentIds: [] }],
		});
		await expect(
			alice.action(api.platform.vaultActions.update, {
				vaultProviderId,
				name: "renamed",
				providerType: "hashicorp",
				config: { ...masked, url: "https://attacker.example.com" },
				assignments: [],
			}),
		).rejects.toThrow(/connection settings/);
		await expect(
			alice.action(api.platform.vaultActions.update, {
				vaultProviderId,
				name: "renamed",
				providerType: "doppler",
				config: { serviceToken: "********" },
				assignments: [],
			}),
		).rejects.toThrow(/provider type/);

		hashicorpVault({ "app/prod": { PASSWORD: "hunter2" } });
		const [resolved] = await t.action(
			internal.platform.vaultActions.resolveReferences,
			{
				organizationId: "org1",
				projectId,
				values: ["DB=${{vault.renamed.app/prod:PASSWORD}}"],
			},
		);
		expect(resolved).toBe("DB=hunter2");
	});

	test("resolveReferences substitutes, and errors on unassigned or missing secrets", async () => {
		const t = setup();
		const { alice, projectId, environmentId } = await seed(t);
		const calls = hashicorpVault({
			"app/prod": { PASSWORD: "hunter2", USER: "admin" },
		});
		const resolve = (values: string[], project = projectId) =>
			t.action(internal.platform.vaultActions.resolveReferences, {
				organizationId: "org1",
				projectId: project,
				environmentId,
				values,
			});

		await expect(
			resolve([
				"A=${{vault.main.app/prod:USER}}\nB=${{vault.main.app/prod:PASSWORD}}",
				"PLAIN=1",
			]),
		).resolves.toEqual(["A=admin\nB=hunter2", "PLAIN=1"]);
		expect(calls).toHaveLength(1);

		await expect(resolve(["${{vault.main.app/prod:NOPE}}"])).rejects.toThrow(
			/field "NOPE" not found/,
		);
		await expect(resolve(["${{vault.ghost.x:y}}"])).rejects.toThrow(
			/Vault provider "ghost" not found/,
		);
		const { projectId: otherProject } = await alice.mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Other" },
		);
		await expect(
			resolve(["${{vault.main.app/prod:USER}}"], otherProject),
		).rejects.toThrow(/not enabled for this project/);
	});

	test("doppler client resolves from the downloaded config", async () => {
		const t = setup();
		const { alice, projectId } = await seed(t);
		await alice.action(api.platform.vaultActions.create, {
			organizationId: "org1",
			name: "dop",
			providerType: "doppler",
			config: { serviceToken: "dp.st.secret", project: "web" },
			assignments: [{ projectId, environmentIds: [] }],
		});
		const calls = mockFetch((url, init) => {
			const headers = init.headers as Record<string, string>;
			if (
				url.startsWith("https://api.doppler.com/") &&
				headers.Authorization === "Bearer dp.st.secret"
			) {
				return Response.json({ API_KEY: "abc", _UNDERSCORED: "u" });
			}
		});
		await expect(
			t.action(internal.platform.vaultActions.resolveReferences, {
				organizationId: "org1",
				projectId,
				values: ["${{vault.dop.API_KEY}}-${{vault.dop._UNDERSCORED}}"],
			}),
		).resolves.toEqual(["abc-u"]);
		expect(calls[0]?.url).toContain("project=web");
	});

	test("resolveForJob requires the job's lease and the job's organization", async () => {
		const t = setup();
		const { projectId } = await seed(t);
		hashicorpVault({ "app/prod": { PASSWORD: "hunter2" } });
		const agent = asAgent(t, await addAgent(t));
		const jobId = await t.run((ctx) =>
			ctx.db.insert("jobs", {
				organizationId: "org1",
				partition: "local",
				group: "x",
				spec: { kind: "noop", message: "x" },
				status: "queued",
				attempts: 0,
				maxAttempts: 1,
				idempotent: false,
				cancelRequested: false,
			}),
		);
		const claim = await agent.mutation(api.agent.claimNext, {});
		if (!claim) throw new Error("expected a claim");
		const values = ["${{vault.main.app/prod:PASSWORD}}"];

		await expect(
			agent.action(api.platform.vaultActions.resolveForJob, {
				jobId,
				leaseId: claim.leaseId,
				projectId,
				values,
			}),
		).resolves.toEqual(["hunter2"]);
		await expect(
			agent.action(api.platform.vaultActions.resolveForJob, {
				jobId,
				leaseId: "wrong",
				projectId,
				values,
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			asUser(t, "alice").action(api.platform.vaultActions.resolveForJob, {
				jobId,
				leaseId: claim.leaseId,
				projectId,
				values,
			}),
		).rejects.toThrow(/Agent authentication required/);

		const { projectId: foreignProject } = await asUser(t, "mallory").mutation(
			api.projects.create,
			{ organizationId: "org2", name: "Theirs" },
		);
		await expect(
			agent.action(api.platform.vaultActions.resolveForJob, {
				jobId,
				leaseId: claim.leaseId,
				projectId: foreignProject,
				values,
			}),
		).rejects.toThrow(/Project not found/);
	});
});
