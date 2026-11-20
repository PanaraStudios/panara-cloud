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

const COMPOSE = "services:\n  web:\n    image: nginx:alpine\n";

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
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		serverId: source,
		composeFile: COMPOSE,
	});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, source, target, composeId, agent };
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

describe("compose transfer", () => {
	test("authorization and target checks", async () => {
		const { t, alice, source, target, composeId } = await seed();
		await expect(
			asUser(t, "mallory").mutation(api.compose.transfer.start, {
				composeId,
				targetServerId: target,
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "eve").mutation(api.compose.transfer.start, {
				composeId,
				targetServerId: target,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.mutation(api.compose.transfer.start, {
				composeId,
				targetServerId: source,
			}),
		).rejects.toThrow(/already on the selected server/);
	});

	test("switches servers, filters service networks and queues the deploy", async () => {
		const { t, alice, source, target, composeId, agent } = await seed();
		const kept = await addNetwork(t, target, "edge");
		const dropped = await addNetwork(t, source, "old");
		await alice.mutation(api.compose.crud.update, {
			composeId,
			serviceNetworks: [
				{
					serviceName: "web",
					networkIds: [dropped],
					detachPanaraCloudNetwork: false,
				},
			],
		});
		await t.run((ctx) =>
			ctx.db.patch("compose", composeId, {
				serviceNetworks: [
					{
						serviceName: "web",
						networkIds: [kept, dropped],
						detachPanaraCloudNetwork: false,
					},
				],
			}),
		);
		await alice.mutation(api.compose.transfer.start, {
			composeId,
			targetServerId: target,
		});
		const lease = await claim(agent, "compose.transfer");
		await expect(
			agent.query(api.compose.agent.getTransferContext, {
				jobId: lease.jobId,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		const context = await agent.query(
			api.compose.agent.getTransferContext,
			lease,
		);
		expect(context).toMatchObject({
			composeType: "docker-compose",
			source: { host: "10.0.0.1" },
			target: { host: "10.0.0.2" },
		});
		const { warnings } = await agent.mutation(
			api.compose.agent.completeTransfer,
			lease,
		);
		expect(warnings).toEqual([
			"web: detached networks that don't exist on the target: old",
		]);
		const row = await t.run((ctx) => ctx.db.get("compose", composeId));
		expect(row).toMatchObject({
			serverId: target,
			serviceNetworks: [{ serviceName: "web", networkIds: [kept] }],
		});
		const deploy = await t.run(async (ctx) =>
			(await ctx.db.query("jobs").collect()).find(
				(job) => job.spec.kind === "compose.deploy",
			),
		);
		expect(deploy?.partition).toBe(target);
	});
});
