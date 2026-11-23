import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

const PEM_CERT =
	"-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----";
const PEM_KEY =
	"-----BEGIN PRIVATE KEY-----\nsuper-secret-key\n-----END PRIVATE KEY-----";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	return t;
};

describe("certificates.listDetailed", () => {
	test("returns chains and servers without private keys", async () => {
		const t = await seed();
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
			enableDockerCleanup: true,
		});
		await alice.action(api.infra.certificates.create, {
			organizationId: "org1",
			serverId,
			name: "remote",
			certificateData: PEM_CERT,
			privateKey: PEM_KEY,
		});
		await alice.action(api.infra.certificates.create, {
			organizationId: "org1",
			name: "local",
			certificateData: PEM_CERT,
			privateKey: PEM_KEY,
		});

		await expect(
			asUser(t, "bob").query(api.infra.certificates.listDetailed, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/certificate\.read/);
		const list = await asUser(t, "alice").query(
			api.infra.certificates.listDetailed,
			{ organizationId: "org1" },
		);
		expect(list).toHaveLength(2);
		const remote = list.find((c) => c.name === "remote");
		const local = list.find((c) => c.name === "local");
		expect(remote?.certificateData).toBe(PEM_CERT);
		expect(remote?.server).toEqual({ name: "web-1", ipAddress: "10.0.0.5" });
		expect(local?.server).toBeNull();
		expect(JSON.stringify(list)).not.toContain("PRIVATE KEY");
	});

	test("rejects other organizations", async () => {
		const t = await seed();
		await expect(
			asUser(t, "mallory").query(api.infra.certificates.listDetailed, {
				organizationId: "org1",
			}),
		).rejects.toThrow();
		await expect(
			t.query(api.infra.certificates.listDetailed, { organizationId: "org1" }),
		).rejects.toThrow();
	});
});
