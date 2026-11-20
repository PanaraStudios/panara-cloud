import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addAgent, addMember, asAgent, asUser, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	// org1 holds the oldest membership, so its admins run the panel host.
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const serverId = await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId: "org1",
			name: "gpu-1",
			ipAddress: "10.0.0.7",
			port: 22,
			username: "root",
			sshKeyId: undefined,
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		}),
	);
	return { t, serverId };
};

describe("GPU support", () => {
	test("setup is an admin job in the host's setup group with a history row", async () => {
		const { t, serverId } = await seed();
		await expect(
			asUser(t, "alice").mutation(api.infra.gpu.setup, { serverId }),
		).rejects.toThrow(/SSH key/);
		const sshKeyId = await t.run((ctx) =>
			ctx.db.insert("sshKeys", {
				organizationId: "org1",
				name: "k",
				publicKey: "ssh-ed25519 AAAA",
			}),
		);
		await t.run((ctx) => ctx.db.patch("servers", serverId, { sshKeyId }));
		await expect(
			asUser(t, "mallory").mutation(api.infra.gpu.setup, { serverId }),
		).rejects.toThrow(/admin role/);
		await expect(
			asUser(t, "eve").mutation(api.infra.gpu.setup, { serverId }),
		).rejects.toThrow(/Not a member/);
		const jobId = await asUser(t, "alice").mutation(api.infra.gpu.setup, {
			serverId,
		});
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: serverId,
			group: `traefik:${serverId}`,
			spec: { kind: "infra.gpuSetup", serverId },
		});
		const history = await asUser(t, "alice").query(api.infra.setup.history, {
			serverId,
		});
		expect(history.map((row) => row.title)).toEqual(["GPU Setup"]);
	});

	test("the panel host needs an instance administrator", async () => {
		const { t } = await seed();
		await expect(
			asUser(t, "eve").mutation(api.infra.gpu.setup, {}),
		).rejects.toThrow(/instance administrator/);
		const jobId = await asUser(t, "alice").mutation(api.infra.gpu.setup, {});
		expect(await t.run((ctx) => ctx.db.get("jobs", jobId))).toMatchObject({
			partition: "local",
			group: "traefik:local",
		});
	});

	test("the gpu status snapshot is admin-only and reported by the agent", async () => {
		const { t, serverId } = await seed();
		await expect(
			asUser(t, "mallory").mutation(api.infra.snapshots.refresh, {
				serverId,
				kind: "gpu",
			}),
		).rejects.toThrow(/admin role/);
		await asUser(t, "alice").mutation(api.infra.snapshots.refresh, {
			serverId,
			kind: "gpu",
		});
		const agent = asAgent(t, await addAgent(t));
		const next = await agent.mutation(api.agent.claimNext, {});
		if (!next) throw new Error("expected a claim");
		expect(next.spec).toEqual({ kind: "infra.inspect", serverId, what: "gpu" });
		const status = { driverInstalled: false, availableGPUs: 0 };
		await agent.mutation(api.infra.agent.reportSnapshot, {
			jobId: next.jobId,
			leaseId: next.leaseId,
			kind: "gpu",
			data: JSON.stringify(status),
		});
		const snapshot = await asUser(t, "alice").query(api.infra.snapshots.get, {
			serverId,
			kind: "gpu",
		});
		expect(JSON.parse(snapshot.data ?? "null")).toEqual(status);
		await expect(
			asUser(t, "mallory").query(api.infra.snapshots.get, {
				serverId,
				kind: "gpu",
			}),
		).rejects.toThrow(/admin role/);
	});
});
