import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";

const PEM_CERT =
	"-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----";
const PEM_KEY =
	"-----BEGIN PRIVATE KEY-----\nsuper-secret-key\n-----END PRIVATE KEY-----";

const createServerWithKey = async (
	t: TestConvex,
	enableDockerCleanup = true,
) => {
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "key",
		publicKey: "ssh-ed25519 AAAAC3Nza test",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	return await alice.mutation(api.servers.create, {
		organizationId: "org1",
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup,
	});
};

// org1 is the first organization, so its owner and admins run the instance.
const setupInstance = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "admin");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

const claim = async (t: TestConvex) => {
	const agent = asAgent(t, await addAgent(t));
	const next = await agent.mutation(api.agent.claimNext, {});
	if (!next) throw new Error("expected a claim");
	return {
		agent,
		claim: next,
		lease: { jobId: next.jobId, leaseId: next.leaseId },
	};
};

describe("instance administration", () => {
	test("only owners/admins of the first organization manage the panel host", async () => {
		const t = await setupInstance();
		const jobId = await asUser(t, "bob").mutation(api.infra.setup.run, {});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: "local",
			organizationId: "org1",
			group: "traefik:local",
			spec: { kind: "infra.serverSetup" },
		});
		await expect(
			asUser(t, "eve").mutation(api.infra.setup.run, {}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "mallory").mutation(api.infra.setup.run, {}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "eve").mutation(api.infra.webServer.assignDomain, {
				host: "panel.example.com",
				https: false,
				certificateType: "none",
			}),
		).rejects.toThrow(/instance administrator/);
		expect(
			await asUser(t, "eve").query(api.infra.webServer.isInstanceAdmin, {}),
		).toBe(false);
		expect(
			await asUser(t, "alice").query(api.infra.webServer.isInstanceAdmin, {}),
		).toBe(true);
	});

	test("assigning the panel domain stores settings and queues a web server apply", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		await expect(
			alice.mutation(api.infra.webServer.assignDomain, {
				host: "panel.example.com",
				https: true,
				certificateType: "letsencrypt",
			}),
		).rejects.toThrow(/email/);
		const jobId = await alice.mutation(api.infra.webServer.assignDomain, {
			host: "panel.example.com",
			https: true,
			certificateType: "letsencrypt",
			letsEncryptEmail: "ops@example.com",
		});
		const seenByOtherOrganization = await asUser(t, "eve").query(
			api.infra.webServer.get,
			{},
		);
		expect(seenByOtherOrganization).toMatchObject({
			host: "panel.example.com",
			https: true,
		});
		expect(seenByOtherOrganization.letsEncryptEmail).toBeUndefined();
		expect(
			await asUser(t, "alice").query(api.infra.webServer.get, {}),
		).toMatchObject({ letsEncryptEmail: "ops@example.com" });
		const { agent, lease } = await claim(t);
		expect(lease.jobId).toBe(jobId);
		expect(
			await agent.query(api.infra.agent.getWebServerConfig, lease),
		).toEqual({
			host: "panel.example.com",
			https: true,
			certificateType: "letsencrypt",
			letsEncryptEmail: "ops@example.com",
		});
	});
});

describe("server setup and snapshots", () => {
	test("setup records a deployment and hands the agent its context", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		await expect(
			asUser(t, "mallory").mutation(api.infra.setup.run, { serverId }),
		).rejects.toThrow(/admin role/);
		await expect(
			asUser(t, "eve").mutation(api.infra.setup.run, { serverId }),
		).rejects.toThrow(/Not a member/);
		const jobId = await asUser(t, "bob").mutation(api.infra.setup.run, {
			serverId,
		});
		const history = await asUser(t, "alice").query(api.infra.setup.history, {
			serverId,
		});
		expect(history).toEqual([
			expect.objectContaining({
				jobId,
				title: "Setup Server",
				status: "queued",
			}),
		]);
		const { agent, lease } = await claim(t);
		expect(await agent.query(api.infra.agent.getSetupContext, lease)).toEqual({
			isLocal: false,
			name: "web-1",
			serverType: "deploy",
			advertiseAddr: "10.0.0.5",
			customScript: null,
		});
		expect(await agent.query(api.infra.agent.getTraefikDesired, lease)).toEqual(
			{
				additionalPorts: [],
				dashboardEnabled: false,
				env: null,
			},
		);
	});

	test("refreshes collapse, the agent reports, and admin-only kinds stay private", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const mallory = asUser(t, "mallory");
		const first = await mallory.mutation(api.infra.snapshots.refresh, {
			serverId,
			kind: "containers",
		});
		expect(
			await mallory.mutation(api.infra.snapshots.refresh, {
				serverId,
				kind: "containers",
			}),
		).toBe(first);
		await expect(
			mallory.mutation(api.infra.snapshots.refresh, {
				serverId,
				kind: "sshSecurity",
			}),
		).rejects.toThrow(/admin role/);
		await expect(
			asUser(t, "eve").query(api.infra.snapshots.get, {
				serverId,
				kind: "containers",
			}),
		).rejects.toThrow(/Not a member/);

		const { agent, lease } = await claim(t);
		await agent.mutation(api.infra.agent.reportSnapshot, {
			...lease,
			kind: "containers",
			data: JSON.stringify([{ name: "web", "com.docker.label": "$x" }]),
		});
		await agent.mutation(api.infra.agent.reportSnapshot, {
			...lease,
			kind: "containers",
			data: "null",
			error: "docker unreachable",
		});
		const snapshot = await mallory.query(api.infra.snapshots.get, {
			serverId,
			kind: "containers",
		});
		expect(JSON.parse(snapshot.data ?? "null")).toEqual([
			{ name: "web", "com.docker.label": "$x" },
		]);
		expect(snapshot).toMatchObject({
			error: "docker unreachable",
			pendingJobId: first,
		});
		await expect(
			agent.mutation(api.infra.agent.reportSnapshot, {
				...lease,
				kind: "containers",
				data: "x".repeat(1_000_000),
			}),
		).rejects.toThrow(/too large/);
	});

	test("inspect results go to a restricted op slot for join tokens", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const bob = asUser(t, "bob");
		await expect(
			bob.mutation(api.infra.docker.run, {
				serverId,
				action: { type: "containerRestart", containerId: "abc; rm -rf /" },
			}),
		).rejects.toThrow(/Invalid Docker object/);
		const jobId = await bob.mutation(api.infra.docker.run, {
			serverId,
			action: { type: "clusterJoinInfo" },
		});
		const { agent, lease } = await claim(t);
		await agent.mutation(api.infra.agent.reportOpResult, {
			...lease,
			result: JSON.stringify({ worker: "docker swarm join --token SWMTKN" }),
		});
		expect(
			await bob.query(api.infra.snapshots.opResult, { jobId }),
		).toMatchObject({
			status: "running",
			result: expect.stringContaining("SWMTKN"),
		});
		await expect(
			asUser(t, "mallory").query(api.infra.snapshots.opResult, { jobId }),
		).rejects.toThrow(/admin role/);
	});

	test("security actions are validated before they reach the server", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const bob = asUser(t, "bob");
		await expect(
			bob.mutation(api.infra.serverSecurity.run, {
				serverId,
				action: {
					type: "updateSsh",
					passwordAuthentication: false,
					permitRootLogin: "no",
					maxAuthTries: 3,
				},
			}),
		).rejects.toThrow(/connects to this server as root/);
		await expect(
			bob.mutation(api.infra.serverSecurity.run, {
				serverId,
				action: { type: "banIp", ip: "1.2.3.4; reboot" },
			}),
		).rejects.toThrow(/Invalid IP/);
		await bob.mutation(api.infra.serverSecurity.run, {
			serverId,
			action: { type: "banIp", ip: "203.0.113.9" },
		});
	});
});

describe("certificates and traefik settings", () => {
	test("private keys are encrypted and only decrypted for the agent", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const alice = asUser(t, "alice");
		await expect(
			asUser(t, "mallory").action(api.infra.certificates.create, {
				organizationId: "org1",
				serverId,
				name: "wildcard",
				certificateData: PEM_CERT,
				privateKey: PEM_KEY,
			}),
		).rejects.toThrow(/admin role/);
		const certificateId = await alice.action(api.infra.certificates.create, {
			organizationId: "org1",
			serverId,
			name: "wildcard",
			certificateData: PEM_CERT,
			privateKey: PEM_KEY,
		});
		const stored = await t.run(async (ctx) => ({
			certificates: await ctx.db.query("certificates").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		expect(JSON.stringify(stored)).not.toContain("super-secret-key");
		await expect(
			asUser(t, "mallory").query(api.infra.certificates.get, {
				certificateId,
			}),
		).rejects.toThrow(/certificate\.read/);
		const viewed = await asUser(t, "bob").query(api.infra.certificates.get, {
			certificateId,
		});
		expect(viewed?.certificateData).toBe(PEM_CERT);
		expect(JSON.stringify(viewed)).not.toContain("PRIVATE KEY");

		const { agent, lease } = await claim(t);
		const forAgent = await agent.query(api.infra.agent.getCertificate, lease);
		expect(forAgent?.privateKey).toBe(PEM_KEY);
		expect(forAgent?.certificatePath).toMatch(/^certificate-[0-9a-f]{12}$/);

		await alice.mutation(api.infra.certificates.remove, { certificateId });
		const removal = await t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).find(
				(job) => job.spec.kind === "infra.certificateRemove",
			),
		);
		expect(removal?.spec).toEqual({
			kind: "infra.certificateRemove",
			certificatePath: forAgent?.certificatePath,
		});
		expect(
			await t.run(async (ctx) =>
				(await ctx.db.query("secrets").collect()).filter(
					(s) => s.kind === "infra.certificateKey",
				),
			),
		).toEqual([]);
	});

	test("traefik env is encrypted and ports are validated", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const alice = asUser(t, "alice");
		await expect(
			alice.mutation(api.infra.webServer.setAdditionalPorts, {
				serverId,
				additionalPorts: [
					{ targetPort: 80, publishedPort: 443, protocol: "tcp" },
				],
			}),
		).rejects.toThrow(/managed by Panara Cloud/);
		await alice.mutation(api.infra.webServer.setAdditionalPorts, {
			serverId,
			additionalPorts: [
				{ targetPort: 5432, publishedPort: 5432, protocol: "tcp" },
			],
		});
		await alice.action(api.infra.webServer.setTraefikEnv, {
			serverId,
			env: "CF_DNS_API_TOKEN=token-value",
		});
		expect(
			JSON.stringify(await t.run((ctx) => ctx.db.query("secrets").collect())),
		).not.toContain("token-value");
		const { agent, lease } = await claim(t);
		expect(await agent.query(api.infra.agent.getTraefikDesired, lease)).toEqual(
			{
				additionalPorts: [
					{ targetPort: 5432, publishedPort: 5432, protocol: "tcp" },
				],
				dashboardEnabled: false,
				env: "CF_DNS_API_TOKEN=token-value",
			},
		);
		await expect(
			alice.mutation(api.infra.webServer.readTraefikFile, {
				serverId,
				path: "../../etc/shadow",
			}),
		).rejects.toThrow(/Invalid Traefik file path/);
		await expect(
			alice.mutation(api.infra.webServer.readTraefikFile, {
				serverId,
				path: "dynamic/acme.json",
			}),
		).rejects.toThrow(/acme.json/);
		for (const path of [
			"dynamic/certificates/certificate-abc123/privkey.key",
			"Dynamic/Certificates/certificate-abc123/chain.crt",
			"dynamic/custom/tls.pem",
		]) {
			await expect(
				alice.mutation(api.infra.webServer.readTraefikFile, { serverId, path }),
			).rejects.toThrow(/Certificates page/);
			await expect(
				alice.mutation(api.infra.webServer.writeTraefikFile, {
					serverId,
					path,
					content: "x",
				}),
			).rejects.toThrow(/Certificates page/);
		}
	});
});

describe("networks", () => {
	test("network creation is reported back by the agent", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const alice = asUser(t, "alice");
		await expect(
			alice.mutation(api.infra.networks.create, {
				organizationId: "org1",
				serverId,
				name: "panara-cloud-network",
				driver: "overlay",
			}),
		).rejects.toThrow(/reserved/);
		await expect(
			asUser(t, "eve").mutation(api.infra.networks.create, {
				organizationId: "org2",
				serverId,
				name: "backend",
				driver: "overlay",
			}),
		).rejects.toThrow(/Server not found/);
		const networkId = await alice.mutation(api.infra.networks.create, {
			organizationId: "org1",
			serverId,
			name: "backend",
			driver: "overlay",
			ipamConfig: [{ subnet: "10.20.0.0/24" }],
		});
		await expect(
			alice.mutation(api.infra.networks.create, {
				organizationId: "org1",
				serverId,
				name: "backend",
				driver: "bridge",
			}),
		).rejects.toThrow(/already exists/);
		const { agent, lease } = await claim(t);
		expect(await agent.query(api.infra.agent.getNetwork, lease)).toMatchObject({
			name: "backend",
			attachable: true,
		});
		await agent.mutation(api.infra.agent.reportNetwork, {
			...lease,
			dockerId: "n123",
		});
		expect(
			await t.run((ctx) => ctx.db.get("networks", networkId as Id<"networks">)),
		).toMatchObject({ status: "created", dockerId: "n123" });
	});
});

describe("scheduled cleanup", () => {
	const cleanupJobs = (t: TestConvex) =>
		t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).filter(
				(job) => job.spec.kind === "infra.dockerCleanup",
			),
		);

	test("queues one cleanup per server that has it on, once a day", async () => {
		const t = await setupInstance();
		const enabled = await createServerWithKey(t, true);
		await createServerWithKey(t, false);
		await t.mutation(internal.infra.cleanup.enqueueScheduledCleanups, {});
		await t.mutation(internal.infra.cleanup.enqueueScheduledCleanups, {});
		const jobs = await cleanupJobs(t);
		expect(jobs.map((job) => job.partition)).toEqual([enabled]);
		expect(
			jobs.every(
				(job) =>
					job.spec.kind === "infra.dockerCleanup" && job.spec.scope === "all",
			),
		).toBe(true);
	});

	test("is off for a new server and for the panel host until someone turns it on", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		const sshKeyId = await alice.action(api.sshKeys.create, {
			organizationId: "org1",
			name: "key",
			publicKey: "ssh-ed25519 AAAAC3Nza test",
			privateKey:
				"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
		});
		const serverId = await alice.mutation(api.servers.create, {
			organizationId: "org1",
			name: "web-1",
			ipAddress: "10.0.0.5",
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
		});
		expect(await t.run((ctx) => ctx.db.get("servers", serverId))).toMatchObject(
			{ enableDockerCleanup: false },
		);
		expect(await alice.query(api.infra.webServer.get, {})).toMatchObject({
			enableDockerCleanup: false,
		});
		await t.mutation(internal.infra.cleanup.enqueueScheduledCleanups, {});
		expect(await cleanupJobs(t)).toHaveLength(0);

		await alice.mutation(api.infra.docker.setDockerCleanup, { enabled: true });
		await alice.mutation(api.infra.docker.setDockerCleanup, {
			serverId,
			enabled: true,
		});
		expect(await alice.query(api.infra.webServer.get, {})).toMatchObject({
			enableDockerCleanup: true,
		});
		await t.mutation(internal.infra.cleanup.enqueueScheduledCleanups, {});
		expect((await cleanupJobs(t)).map((job) => job.partition).sort()).toEqual(
			[serverId, "local"].sort(),
		);

		await alice.mutation(api.infra.docker.setDockerCleanup, { enabled: false });
		expect(await alice.query(api.infra.webServer.get, {})).toMatchObject({
			enableDockerCleanup: false,
		});
	});

	test("a panel host that had it on keeps it", async () => {
		const t = await setupInstance();
		await t.run((ctx) =>
			ctx.db.insert("webServerSettings", {
				key: "instance",
				https: false,
				certificateType: "none",
				enableDockerCleanup: true,
				cleanupCacheApplications: false,
				cleanupCacheOnPreviews: false,
				cleanupCacheOnCompose: false,
			}),
		);
		await t.mutation(internal.install.configureWebServer, { https: false });
		await t.mutation(internal.infra.cleanup.enqueueScheduledCleanups, {});
		expect((await cleanupJobs(t)).map((job) => job.partition)).toEqual([
			"local",
		]);
	});
});

describe("server removal", () => {
	test("cascades snapshots, traefik settings, networks and certificates", async () => {
		const t = await setupInstance();
		const serverId = await createServerWithKey(t);
		const alice = asUser(t, "alice");
		await alice.action(api.infra.webServer.setTraefikEnv, {
			serverId,
			env: "A=1",
		});
		await alice.mutation(api.infra.networks.create, {
			organizationId: "org1",
			serverId,
			name: "backend",
			driver: "bridge",
		});
		await alice.action(api.infra.certificates.create, {
			organizationId: "org1",
			serverId,
			name: "c",
			certificateData: PEM_CERT,
			privateKey: PEM_KEY,
		});
		await t.mutation(internal.infra.cleanup.cascadeServer, {
			serverId,
			organizationId: "org1",
		});
		const left = await t.run(async (ctx) => ({
			traefik: await ctx.db.query("traefikSettings").collect(),
			networks: await ctx.db.query("networks").collect(),
			certificates: await ctx.db.query("certificates").collect(),
			chains: await ctx.db.query("certificateChains").collect(),
			secrets: (await ctx.db.query("secrets").collect()).filter((s) =>
				s.kind.startsWith("infra."),
			),
		}));
		expect(left).toEqual({
			traefik: [],
			networks: [],
			certificates: [],
			chains: [],
			secrets: [],
		});
	});
});
