import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { api } from "../_generated/api";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import {
	buildVectorConfigYaml,
	collectSecretValues,
	type VectorProvider,
} from "./lib/vectorConfig";

const LOKI_TOKEN = "loki-super-secret-token";
const LOKI_ENDPOINT = "https://loki.secret-host.example";

const createLoki = (t: TestConvex, user = "alice", organizationId = "org1") =>
	asUser(t, user).action(api.platform.telemetryActions.create, {
		organizationId,
		name: "Loki",
		providerType: "loki",
		signals: ["logs"],
		endpoint: LOKI_ENDPOINT,
		apiKey: LOKI_TOKEN,
		extraConfig: { username: "12345", tenantId: "tenant-a" },
	});

const loki: VectorProvider = {
	telemetryProviderId: "p1",
	name: "Loki",
	providerType: "loki",
	signals: ["logs"],
	endpoint: "loki.example.com",
	apiKey: "loki-token",
	apiSecret: null,
	extraConfig: { username: "user-1", tenantId: "tenant-a" },
};

const datadog: VectorProvider = {
	telemetryProviderId: "p2",
	name: "Datadog",
	providerType: "datadog",
	signals: ["logs", "metrics"],
	endpoint: null,
	apiKey: "dd-key",
	apiSecret: null,
	extraConfig: { site: "https://datadoghq.eu/" },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vector config", () => {
	test("renders sources, scope transforms and provider sinks", () => {
		const { yaml, skipped } = buildVectorConfigYaml({
			logProviders: [loki, datadog],
			metricsProviders: [datadog],
			organizationId: "org1",
			serverName: "Panara Cloud Server (local)",
		});
		expect(skipped).toEqual([]);
		const config = parse(yaml);
		expect(Object.keys(config.sources)).toEqual([
			"docker_logs_source",
			"host_metrics_source",
			"cadvisor_source",
		]);
		expect(config.transforms.panara_cloud_scope_local_only).toMatchObject({
			type: "filter",
			inputs: ["panara_cloud_scope"],
			condition: '.panara_cloud_organization == "org1"',
		});
		expect(config.sinks.sink_p1).toMatchObject({
			type: "loki",
			inputs: ["panara_cloud_scope_local_only"],
			endpoint: "https://loki.example.com",
			tenant_id: "tenant-a",
			auth: { strategy: "basic", user: "user-1", password: "loki-token" },
		});
		expect(config.transforms.transform_p2.inputs).toEqual([
			"panara_cloud_scope_local_only",
		]);
		expect(config.sinks.sink_p2).toMatchObject({
			type: "datadog_logs",
			inputs: ["transform_p2"],
			site: "datadoghq.eu",
		});
		expect(config.sinks.sink_p2_metrics).toMatchObject({
			type: "datadog_metrics",
			inputs: ["panara_cloud_metrics_scope_local_only"],
		});
	});

	test("remote servers are not org-filtered and invalid providers are skipped", () => {
		const broken: VectorProvider = {
			...loki,
			telemetryProviderId: "p3",
			providerType: "new_relic",
			signals: ["metrics"],
			extraConfig: { region: "mars" },
		};
		const { yaml, skipped } = buildVectorConfigYaml({
			logProviders: [loki],
			metricsProviders: [broken],
			serverName: "web-1",
		});
		const config = parse(yaml);
		expect(config.sinks.sink_p1.inputs).toEqual(["panara_cloud_scope"]);
		expect(config.sinks.sink_p3_metrics).toBeUndefined();
		expect(skipped[0]).toContain("region");
		expect(collectSecretValues([loki, datadog])).toEqual([
			"loki.example.com",
			"loki-token",
			"dd-key",
		]);
	});
});

describe("telemetry providers", () => {
	test("credentials are encrypted and never returned", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const providerId = await createLoki(t);

		const stored = await t.run(async (ctx) => ({
			secrets: await ctx.db.query("secrets").collect(),
			providers: await ctx.db.query("telemetryProviders").collect(),
		}));
		expect(stored.secrets).toHaveLength(1);
		expect(JSON.stringify(stored)).not.toContain(LOKI_TOKEN);
		expect(JSON.stringify(stored)).not.toContain("secret-host");

		await expect(
			asUser(t, "bob").query(api.platform.telemetry.list, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/telemetryProvider\.read permission/);
		const alice = asUser(t, "alice");
		const listed = await alice.query(api.platform.telemetry.list, {
			organizationId: "org1",
		});
		const one = await alice.query(api.platform.telemetry.get, {
			telemetryProviderId: providerId,
		});
		expect(listed).toHaveLength(1);
		expect(JSON.stringify([listed, one])).not.toContain(LOKI_TOKEN);
		expect(JSON.stringify([listed, one])).not.toContain("secret-host");
	});

	test("members read, only admins write, other orgs see nothing", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const providerId = await createLoki(t);

		await expect(createLoki(t, "bob")).rejects.toThrow(
			/Requires the [a-zA-Z]+\.[a-z]+ permission/,
		);
		await expect(
			asUser(t, "bob").mutation(api.platform.telemetry.remove, {
				telemetryProviderId: providerId,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "bob").action(api.platform.telemetryActions.update, {
				telemetryProviderId: providerId,
				name: "x",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.platform.telemetry.get, {
				telemetryProviderId: providerId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.query(api.platform.telemetry.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.mutation(api.platform.telemetry.setVectorTargetProviders, {
				organizationId: "org2",
				providerIds: [providerId],
			}),
		).rejects.toThrow(/instance administrator/);
	});

	test("validates signals and required credential fields", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		await expect(
			alice.action(api.platform.telemetryActions.create, {
				organizationId: "org1",
				name: "Loki metrics",
				providerType: "loki",
				signals: ["metrics"],
				endpoint: LOKI_ENDPOINT,
			}),
		).rejects.toThrow(/cannot send metrics/);
		await expect(
			alice.action(api.platform.telemetryActions.create, {
				organizationId: "org1",
				name: "Splunk",
				providerType: "splunk_hec",
				signals: ["logs", "metrics"],
				endpoint: "https://splunk.example.com:8088",
				apiKey: "hec",
			}),
		).rejects.toThrow(/Metrics index/);
	});

	test("selecting providers enqueues a reconcile job whose context only the leased agent can read", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		const providerId = await createLoki(t);
		const alice = asUser(t, "alice");

		const { jobId } = await alice.mutation(
			api.platform.telemetry.setVectorTargetProviders,
			{ organizationId: "org1", providerIds: [providerId] },
		);
		const claim = await agent.mutation(api.agent.claimNext, {});
		expect(claim).toMatchObject({
			jobId,
			partition: "local",
			spec: { kind: "platform.vectorReconcile" },
		});
		if (!claim) throw new Error("expected a claim");

		await expect(
			alice.query(api.platform.agent.getVectorReconcileContext, {
				jobId,
				leaseId: claim.leaseId,
			}),
		).rejects.toThrow(/Agent authentication required/);
		await expect(
			agent.query(api.platform.agent.getVectorReconcileContext, {
				jobId,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);

		const context = await agent.query(
			api.platform.agent.getVectorReconcileContext,
			{ jobId, leaseId: claim.leaseId },
		);
		if (context.mode !== "apply") throw new Error("expected apply");
		expect(context.metrics).toBe(false);
		expect(context.secrets).toContain(LOKI_TOKEN);
		const config = parse(context.configYaml);
		expect(config.sinks[`sink_${providerId}`]).toMatchObject({
			endpoint: LOKI_ENDPOINT,
			auth: { password: LOKI_TOKEN },
		});

		const status = await alice.query(api.platform.telemetry.vectorStatus, {
			organizationId: "org1",
		});
		expect(status[0]).toMatchObject({
			serverId: null,
			providerIds: [providerId],
			lastJob: { jobId, status: "running" },
		});
		expect(JSON.stringify(status)).not.toContain(LOKI_TOKEN);
	});

	test("only the instance administrator assigns the panel host's agent", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org2", "mallory", "owner");
		const alicesProvider = await createLoki(t);
		const mallorysProvider = await createLoki(t, "mallory", "org2");

		await expect(
			asUser(t, "mallory").mutation(
				api.platform.telemetry.setVectorTargetProviders,
				{ organizationId: "org2", providerIds: [mallorysProvider] },
			),
		).rejects.toThrow(/instance administrator/);
		// A target another organization held before is taken back.
		await t.run((ctx) =>
			ctx.db.insert("vectorTargets", {
				organizationId: "org2",
				providerIds: [mallorysProvider],
			}),
		);
		await asUser(t, "alice").mutation(
			api.platform.telemetry.setVectorTargetProviders,
			{ organizationId: "org1", providerIds: [alicesProvider] },
		);
		const mallorysView = await asUser(t, "mallory").query(
			api.platform.telemetry.vectorStatus,
			{ organizationId: "org2" },
		);
		expect(mallorysView.some((target) => target.serverId === null)).toBe(false);
	});

	test("credential changes and removal re-apply the hosts that use a provider", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const agent = asAgent(t, await addAgent(t));
		const providerId = await createLoki(t);
		const alice = asUser(t, "alice");
		await alice.mutation(api.platform.telemetry.setVectorTargetProviders, {
			organizationId: "org1",
			providerIds: [providerId],
		});

		expect(
			await alice.action(api.platform.telemetryActions.update, {
				telemetryProviderId: providerId,
				name: "Renamed",
			}),
		).toEqual({ reapplied: false, jobIds: [] });
		const rotated = await alice.action(api.platform.telemetryActions.update, {
			telemetryProviderId: providerId,
			apiKey: "rotated-token",
		});
		expect(rotated).toEqual({ reapplied: true, jobIds: [expect.any(String)] });

		const jobsBeforeRemove = await t.run((ctx) =>
			ctx.db.query("jobs").collect(),
		);
		expect(jobsBeforeRemove).toHaveLength(2);
		expect(jobsBeforeRemove.map((job) => job._id)).toContain(rotated.jobIds[0]);

		const removed = await alice.mutation(api.platform.telemetry.remove, {
			telemetryProviderId: providerId,
		});
		expect(removed).toEqual({ reapplied: 1, jobIds: [expect.any(String)] });
		const target = await t.run((ctx) => ctx.db.query("vectorTargets").first());
		expect(target?.lastJobId).toBe(removed.jobIds[0]);
		expect(target?.providerIds).toEqual([]);
		expect(
			await t.run((ctx) => ctx.db.query("secrets").collect()),
		).toHaveLength(0);

		const lastJobId = target?.lastJobId;
		if (!lastJobId) throw new Error("expected a job");
		let claim = await agent.mutation(api.agent.claimNext, {});
		while (claim && claim.jobId !== lastJobId) {
			await agent.mutation(api.agent.complete, {
				jobId: claim.jobId,
				leaseId: claim.leaseId,
				result: { kind: "none" },
			});
			claim = await agent.mutation(api.agent.claimNext, {});
		}
		if (!claim) throw new Error("expected the removal job");
		const context = await agent.query(
			api.platform.agent.getVectorReconcileContext,
			{ jobId: claim.jobId, leaseId: claim.leaseId },
		);
		expect(context.mode).toBe("remove");
	});

	test("connection tests use the provider API without leaking through errors", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const fetchMock = vi.fn(
			async (..._args: unknown[]) => new Response(null, { status: 204 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const providerId = await createLoki(t);

		await expect(
			asUser(t, "alice").action(
				api.platform.telemetryActions.testConnectionById,
				{ telemetryProviderId: providerId },
			),
		).resolves.toEqual({ success: true });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${LOKI_ENDPOINT}/loki/api/v1/push`);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${btoa(`12345:${LOKI_TOKEN}`)}`,
		);
		expect((init.headers as Record<string, string>)["X-Scope-OrgID"]).toBe(
			"tenant-a",
		);

		await expect(
			asUser(t, "bob").action(api.platform.telemetryActions.testConnection, {
				organizationId: "org1",
				providerType: "loki",
				signals: ["logs"],
				endpoint: LOKI_ENDPOINT,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);

		fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
		await expect(
			asUser(t, "alice").action(api.platform.telemetryActions.testConnection, {
				organizationId: "org1",
				providerType: "loki",
				signals: ["logs"],
				endpoint: "http://169.254.169.254/latest",
			}),
		).rejects.toThrow(/private or internal network/);
	});
});
