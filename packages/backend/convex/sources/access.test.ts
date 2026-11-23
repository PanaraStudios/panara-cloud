import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const PRIVATE_KEY =
	"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org1", "carol", "member");
	await addMember(t, "org2", "mallory", "owner");
	return t;
};

const createGitlab = (t: ReturnType<typeof setup>, user: string) =>
	asUser(t, user).action(api.sources.gitlab.create, {
		organizationId: "org1",
		name: `GitLab ${user}`,
		gitlabUrl: "https://gitlab.example.com",
		applicationId: "app-id",
		secret: "client-secret",
	});

describe("git provider grants", () => {
	test("members with the git providers grant create and manage their own", async () => {
		const t = await seed();
		await expect(createGitlab(t, "bob")).rejects.toThrow(
			/gitProviders\.create permission/,
		);
		await grantMember(t, "org1", "bob", {
			flags: { canAccessToGitProviders: true },
		});
		const own = await createGitlab(t, "bob");
		const owners = await createGitlab(t, "alice");
		expect(
			(
				await asUser(t, "bob").query(api.sources.providers.list, {
					organizationId: "org1",
				})
			).map((provider) => provider._id),
		).toEqual([own]);
		await asUser(t, "bob").mutation(api.sources.providers.rename, {
			gitProviderId: own,
			name: "Mine",
		});
		await expect(
			asUser(t, "bob").mutation(api.sources.providers.rename, {
				gitProviderId: owners,
				name: "Taken",
			}),
		).rejects.toThrow(/your own/);
		await expect(
			asUser(t, "bob").mutation(api.sources.providers.remove, {
				gitProviderId: owners,
			}),
		).rejects.toThrow(/your own/);
		await asUser(t, "bob").mutation(api.sources.providers.remove, {
			gitProviderId: own,
		});
		await expect(
			asUser(t, "carol").mutation(api.sources.providers.rename, {
				gitProviderId: owners,
				name: "x",
			}),
		).rejects.toThrow(/gitProviders\.create permission/);
		await asUser(t, "alice").mutation(api.sources.providers.rename, {
			gitProviderId: owners,
			name: "Still the owner's",
		});
	});
});

describe("ssh key grants", () => {
	test("members with the SSH keys grant list, create and delete keys", async () => {
		const t = await seed();
		const create = (user: string) =>
			asUser(t, user).action(api.sshKeys.create, {
				organizationId: "org1",
				name: `key ${user}`,
				publicKey: "ssh-ed25519 AAAAC3Nza test",
				privateKey: PRIVATE_KEY,
			});
		const ownerKey = await create("alice");
		await expect(create("bob")).rejects.toThrow(/sshKeys\.create permission/);
		await expect(
			asUser(t, "bob").query(api.sshKeys.list, { organizationId: "org1" }),
		).rejects.toThrow(/sshKeys\.read permission/);
		await expect(
			asUser(t, "bob").mutation(api.sshKeys.remove, { sshKeyId: ownerKey }),
		).rejects.toThrow(/sshKeys\.delete permission/);
		expect(
			await asUser(t, "bob").query(api.sshKeys.listForApps, {
				organizationId: "org1",
			}),
		).toEqual([{ _id: ownerKey, name: "key alice" }]);

		await grantMember(t, "org1", "bob", {
			flags: { canAccessToSSHKeys: true },
		});
		const bobKey = await create("bob");
		expect(
			await asUser(t, "bob").query(api.sshKeys.list, {
				organizationId: "org1",
			}),
		).toHaveLength(2);
		await asUser(t, "bob").mutation(api.sshKeys.remove, { sshKeyId: bobKey });
		await expect(
			asUser(t, "mallory").query(api.sshKeys.listForApps, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});
});
