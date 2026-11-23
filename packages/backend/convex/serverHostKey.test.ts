import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resolveHostTarget } from "./lib/targets";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "./test.setup";

const KEY_A = `SHA256:${"A".repeat(43)}`;
const KEY_B = `SHA256:${"B".repeat(43)}`;

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "deploy key",
		publicKey: "ssh-ed25519 AAAAC3Nza panel",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	const fields = {
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy" as const,
		enableDockerCleanup: true,
	};
	const serverId = await alice.mutation(api.servers.create, {
		organizationId: "org1",
		...fields,
	});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, agent, serverId, fields };
};

const hostKeyOf = (t: TestConvex, serverId: Id<"servers">) =>
	t.run(async (ctx) => (await ctx.db.get("servers", serverId))?.sshHostKey);

describe("SSH host keys (trust on first use)", () => {
	test("the agent records the first key and never replaces it", async () => {
		const { t, agent, serverId } = await seed();
		expect(
			await agent.mutation(api.agent.recordHostKey, {
				serverId,
				fingerprint: KEY_A,
			}),
		).toEqual({ recorded: true, matches: true });
		expect(
			await agent.mutation(api.agent.recordHostKey, {
				serverId,
				fingerprint: KEY_B,
			}),
		).toEqual({ recorded: false, matches: false });
		expect(await hostKeyOf(t, serverId)).toBe(KEY_A);
		const target = await t.run((ctx) => resolveHostTarget(ctx, serverId));
		expect(target).toMatchObject({ type: "ssh", hostKey: KEY_A });
	});

	test("only agents record keys, in the fingerprint format", async () => {
		const { t, alice, agent, serverId } = await seed();
		await expect(
			alice.mutation(api.agent.recordHostKey, { serverId, fingerprint: KEY_A }),
		).rejects.toThrow();
		await expect(
			agent.mutation(api.agent.recordHostKey, {
				serverId,
				fingerprint: "ssh-rsa AAAA",
			}),
		).rejects.toThrow(/Invalid host key fingerprint/);
		expect(await hostKeyOf(t, serverId)).toBeFalsy();
	});

	test("server admins reset the key; members and other organizations can't", async () => {
		const { t, alice, agent, serverId } = await seed();
		await agent.mutation(api.agent.recordHostKey, {
			serverId,
			fingerprint: KEY_A,
		});
		await expect(
			asUser(t, "mallory").mutation(api.servers.resetHostKey, { serverId }),
		).rejects.toThrow();
		await expect(
			asUser(t, "eve").mutation(api.servers.resetHostKey, { serverId }),
		).rejects.toThrow();
		expect(await hostKeyOf(t, serverId)).toBe(KEY_A);
		await alice.mutation(api.servers.resetHostKey, { serverId });
		expect(await hostKeyOf(t, serverId)).toBeFalsy();
	});

	test("a new address forgets the key; other edits keep it", async () => {
		const { t, alice, agent, serverId, fields } = await seed();
		await agent.mutation(api.agent.recordHostKey, {
			serverId,
			fingerprint: KEY_A,
		});
		await alice.mutation(api.servers.update, {
			serverId,
			...fields,
			name: "renamed",
		});
		expect(await hostKeyOf(t, serverId)).toBe(KEY_A);
		await alice.mutation(api.servers.update, {
			serverId,
			...fields,
			ipAddress: "10.0.0.6",
		});
		expect(await hostKeyOf(t, serverId)).toBeFalsy();
	});
});
