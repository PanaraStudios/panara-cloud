import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	return t;
};

describe("sshKeygen.generateKeyPair", () => {
	test("returns an OpenSSH keypair without storing it", async () => {
		const t = await seed();
		for (const type of ["ed25519", "rsa"] as const) {
			const pair = await asUser(t, "alice").action(
				api.sources.sshKeygen.generateKeyPair,
				{ organizationId: "org1", type },
			);
			expect(pair.publicKey).toMatch(
				type === "rsa" ? /^ssh-rsa / : /^ssh-ed25519 /,
			);
			expect(pair.privateKey).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
		}
		const stored = await t.run(async (ctx) => ({
			keys: await ctx.db.query("sshKeys").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		expect(stored).toEqual({ keys: [], secrets: [] });
	});

	test("requires an admin of the organization", async () => {
		const t = await seed();
		await expect(
			asUser(t, "bob").action(api.sources.sshKeygen.generateKeyPair, {
				organizationId: "org1",
			}),
		).rejects.toThrow();
		await expect(
			asUser(t, "mallory").action(api.sources.sshKeygen.generateKeyPair, {
				organizationId: "org1",
			}),
		).rejects.toThrow();
	});
});
