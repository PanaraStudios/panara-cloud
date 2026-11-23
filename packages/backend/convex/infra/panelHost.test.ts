import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

// org1 is the root organization: alice (owner) is the instance admin.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	await grantMember(t, "org1", "mallory", {
		flags: { canAccessToDocker: true },
	});
	return t;
};

const certificate = (organizationId: string) => ({
	organizationId,
	name: "edge",
	certificatePath: "certificate-abc",
	certificateData: "-----BEGIN CERTIFICATE-----",
	iv: "iv",
	ciphertext: "ct",
});

describe("panel host rows are for the instance administrator", () => {
	test("tenant admins can't install certificates on the panel host", async () => {
		const t = await seed();
		await expect(
			asUser(t, "eve").mutation(
				internal.infra.certificates.insert,
				certificate("org2"),
			),
		).rejects.toThrow(/instance administrator/);
		const certificateId = await asUser(t, "alice").mutation(
			internal.infra.certificates.insert,
			certificate("org1"),
		);
		// A row a tenant created before can't be changed or removed by it.
		await t.run((ctx) =>
			ctx.db.patch("certificates", certificateId, { organizationId: "org2" }),
		);
		await expect(
			asUser(t, "eve").mutation(api.infra.certificates.remove, {
				certificateId,
			}),
		).rejects.toThrow(/instance administrator/);
	});

	test("Docker networks on the panel host need the instance admin", async () => {
		const t = await seed();
		const network = (organizationId: string) => ({
			organizationId,
			name: "shared",
			driver: "overlay" as const,
		});
		await expect(
			asUser(t, "eve").mutation(api.infra.networks.create, network("org2")),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, "mallory").mutation(api.infra.networks.create, network("org1")),
		).rejects.toThrow(/instance administrator/);
		const networkId = await asUser(t, "alice").mutation(
			api.infra.networks.create,
			network("org1"),
		);
		await expect(
			asUser(t, "mallory").mutation(api.infra.networks.remove, { networkId }),
		).rejects.toThrow(/instance administrator/);
	});

	test("tenant organizations can't run sandboxes on the panel host", async () => {
		const t = await seed();
		await expect(
			asUser(t, "eve").action(api.live.sandboxes.create, {
				organizationId: "org2",
				template: "python",
			}),
		).rejects.toThrow(/instance administrator/);
		await asUser(t, "alice").action(api.live.sandboxes.create, {
			organizationId: "org1",
			template: "python",
		});
	});
});
