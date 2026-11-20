import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";

const createServer = (
	t: TestConvex,
	organizationId: string,
	ip: string,
	serverType: "deploy" | "build" = "deploy",
) =>
	t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: "key",
			publicKey: "ssh-ed25519 AAAA",
		});
		await ctx.db.insert("secrets", {
			organizationId,
			kind: "sshPrivateKey",
			ownerId: sshKeyId,
			...(await encryptSecret(`KEY-${ip}`)),
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: `server-${ip}`,
			ipAddress: ip,
			port: 22,
			username: "root",
			sshKeyId,
			serverType,
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		});
	});

const addNetwork = (
	t: TestConvex,
	serverId: Id<"servers"> | undefined,
	name: string,
	driver: "overlay" | "bridge" = "overlay",
	organizationId = "org1",
) =>
	t.run((ctx) =>
		ctx.db.insert("networks", {
			organizationId,
			serverId,
			name,
			driver,
			internal: false,
			attachable: true,
			enableIPv4: true,
			enableIPv6: false,
			status: "created",
		}),
	);

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const source = await createServer(t, "org1", "10.0.0.1");
	const target = await createServer(t, "org1", "10.0.0.2");
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web", serverId: source },
	);
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, environmentId, source, target, applicationId, agent };
};

const claim = async (agent: ReturnType<typeof asAgent>, kind: string) => {
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

describe("application transfer", () => {
	test("only members with the service transfer to a valid deploy server", async () => {
		const { t, alice, source, target, applicationId } = await seed();
		await expect(
			asUser(t, "mallory").mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: target,
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "eve").mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: target,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: source,
			}),
		).rejects.toThrow(/already on the selected server/);
		const foreign = await createServer(t, "org2", "10.9.9.9");
		await expect(
			alice.mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: foreign,
			}),
		).rejects.toThrow(/Target server not found/);
		const build = await createServer(t, "org1", "10.0.0.3", "build");
		await expect(
			alice.mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: build,
			}),
		).rejects.toThrow(/not available for deployments/);
	});

	test("a domain already used on the target blocks the transfer", async () => {
		const { t, alice, target, applicationId } = await seed();
		await t.run(async (ctx) => {
			const base = {
				organizationId: "org1",
				host: "shop.example.com",
				path: "/",
				port: 3000,
				https: false,
				certificateType: "none" as const,
				internalPath: "/",
				stripPath: false,
				middlewares: [],
				enabled: true,
			};
			const app = await ctx.db.get("applications", applicationId);
			await ctx.db.insert("domains", {
				...base,
				owner: { kind: "application", id: applicationId },
				serverId: app?.serverId,
			});
			await ctx.db.insert("domains", {
				...base,
				owner: { kind: "application", id: "other" },
				serverId: target,
			});
		});
		await expect(
			alice.mutation(api.applications.transfer.start, {
				applicationId,
				targetServerId: target,
			}),
		).rejects.toThrow(/already used on the target server/);
	});

	test("the agent copies data, switches servers and queues the deploy on the target", async () => {
		const { t, alice, source, target, applicationId, agent } = await seed();
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "web-data", mountPath: "/data" },
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "bind", hostPath: "/srv/uploads", mountPath: "/up" },
		});
		const kept = await addNetwork(t, target, "edge");
		const dropped = await addNetwork(t, source, "internal-net");
		await t.run((ctx) =>
			ctx.db.patch("applications", applicationId, {
				networkIds: [kept, dropped],
			}),
		);
		const jobId = await alice.mutation(api.applications.transfer.start, {
			applicationId,
			targetServerId: target,
			removeSourceData: true,
		});
		const deployment = await t.run((ctx) =>
			ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
				.unique(),
		);
		expect(deployment?.title).toBe("Transfer to server-10.0.0.2");

		await expect(
			agent.query(api.applications.agent.getTransferContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			asUser(t, "alice").query(api.applications.agent.getTransferContext, {
				jobId,
				leaseId: "nope",
			}),
		).rejects.toThrow(/Agent authentication required/);

		const lease = await claim(agent, "application.transfer");
		const context = await agent.query(
			api.applications.agent.getTransferContext,
			lease,
		);
		expect(context).toMatchObject({
			volumes: ["web-data"],
			bindPaths: ["/srv/uploads"],
			removeSourceData: true,
			sourceName: "server-10.0.0.1",
			targetName: "server-10.0.0.2",
			source: { type: "ssh", host: "10.0.0.1", privateKey: "KEY-10.0.0.1" },
			target: { type: "ssh", host: "10.0.0.2", privateKey: "KEY-10.0.0.2" },
		});

		const result = await agent.mutation(
			api.applications.agent.completeTransfer,
			lease,
		);
		expect(result.warnings).toEqual([
			"Detached networks that don't exist on the target: internal-net",
		]);
		const app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		expect(app).toMatchObject({ serverId: target, networkIds: [kept] });
		const routing = await t.run((ctx) =>
			ctx.db
				.query("routingOwners")
				.withIndex("by_owner", (q) =>
					q.eq("owner.kind", "application").eq("owner.id", applicationId),
				)
				.unique(),
		);
		expect(routing?.serverId).toBe(target);
		const queued = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("jobs")
					.withIndex("by_status", (q) => q.eq("status", "queued"))
					.collect()
			).map((job) => [job.spec.kind, job.partition]),
		);
		expect(queued).toEqual(
			expect.arrayContaining([
				["infra.routingRemove", source],
				["infra.routingSync", target],
				["application.deploy", target],
			]),
		);
		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		await expect(
			agent.mutation(api.applications.agent.completeTransfer, lease),
		).rejects.toThrow(/Lease lost/);
	});

	test("a failed transfer marks the application as errored", async () => {
		const { t, alice, target, applicationId, agent } = await seed();
		await alice.mutation(api.applications.transfer.start, {
			applicationId,
			targetServerId: target,
		});
		const lease = await claim(agent, "application.transfer");
		await agent.mutation(api.applications.agent.reportTransferStatus, {
			...lease,
			status: "error",
		});
		const app = await t.run((ctx) => ctx.db.get("applications", applicationId));
		expect(app?.status).toBe("error");
		expect(app?.serverId).not.toBe(target);
	});
});

describe("application networks", () => {
	test("only overlay networks on the app's server, applied to the deploy", async () => {
		const { t, alice, source, target, applicationId, agent } = await seed();
		const edge = await addNetwork(t, source, "edge");
		const bridge = await addNetwork(t, source, "local", "bridge");
		const elsewhere = await addNetwork(t, target, "remote");
		const foreign = await addNetwork(t, source, "theirs", "overlay", "org2");
		const update = (networkIds: Id<"networks">[], detach = false) =>
			alice.mutation(api.applications.applications.updateNetworks, {
				applicationId,
				networkIds,
				detachPanaraCloudNetwork: detach,
			});
		await expect(update([bridge])).rejects.toThrow(/overlay/);
		await expect(update([elsewhere])).rejects.toThrow(/not found/);
		await expect(update([foreign])).rejects.toThrow(/not found/);
		await expect(update([], true)).rejects.toThrow(/another network/);
		await expect(
			asUser(t, "mallory").mutation(
				api.applications.applications.updateNetworks,
				{ applicationId, networkIds: [edge], detachPanaraCloudNetwork: false },
			),
		).rejects.toThrow(/service\.create/);

		await update([edge], true);
		await t.run((ctx) =>
			ctx.db.patch("applications", applicationId, {
				source: { type: "docker", image: "nginx:alpine" },
			}),
		);
		await alice.mutation(api.applications.deploy.deploy, { applicationId });
		const lease = await claim(agent, "application.deploy");
		const context = await agent.query(
			api.applications.agent.getDeployContext,
			lease,
		);
		expect(context?.service.swarm.networkSwarm).toEqual([{ Target: "edge" }]);

		await update([edge], false);
		const again = await t.run((ctx) =>
			ctx.db.get("applications", applicationId),
		);
		expect(again).toMatchObject({ networkIds: [edge] });
		expect(again?.detachPanaraCloudNetwork).toBeUndefined();
	});
});
