import { describe, expect, test } from "vitest";
import { api, components } from "./_generated/api";
import { addMember, asUser, setup, type TestConvex } from "./test.setup";

const create = (
	t: TestConvex,
	input: { model: string; data: Record<string, unknown> },
) =>
	t.mutation(components.betterAuth.adapter.create, {
		input: input as never,
	}) as Promise<{ _id: string }>;

const seed = async () => {
	const t = setup();
	const now = Date.now();
	const user = (email: string, twoFactorEnabled = false) =>
		create(t, {
			model: "user",
			data: {
				name: email.split("@")[0],
				email,
				emailVerified: true,
				twoFactorEnabled,
				createdAt: now,
				updatedAt: now,
			},
		});
	const alice = (await user("alice@example.test", true))._id;
	const bob = (await user("bob@example.test"))._id;
	const carol = (await user("carol@example.test"))._id;
	const org = (
		await create(t, {
			model: "organization",
			data: { name: "Acme", slug: "acme", createdAt: now },
		})
	)._id;
	const other = (
		await create(t, {
			model: "organization",
			data: { name: "Other", slug: "other", createdAt: now },
		})
	)._id;
	const member = async (
		organizationId: string,
		userId: string,
		role: "owner" | "admin" | "member",
		createdAt: number,
	) => {
		await create(t, {
			model: "member",
			data: { organizationId, userId, role, createdAt },
		});
		await addMember(t, organizationId, userId, role);
	};
	await member(org, alice, "owner", now - 2);
	await member(org, bob, "member", now - 1);
	await member(other, carol, "owner", now);
	const invite = async (organizationId: string, email: string) =>
		(
			await create(t, {
				model: "invitation",
				data: {
					organizationId,
					email,
					role: "admin",
					status: "pending",
					expiresAt: now + 60_000,
					createdAt: now,
					inviterId: alice,
				},
			})
		)._id;
	const invitation = await invite(org, "dave@example.test");
	const otherInvitation = await invite(other, "erin@example.test");
	return { t, alice, bob, carol, org, other, invitation, otherInvitation };
};

describe("organization users page", () => {
	test("admins list members with their 2FA state", async () => {
		const { t, alice, bob, org } = await seed();
		const members = await asUser(t, alice).query(api.account.members, {
			organizationId: org,
		});
		expect(
			members.map((m) => [m.userId, m.email, m.role, m.twoFactorEnabled]),
		).toEqual([
			[alice, "alice@example.test", "owner", true],
			[bob, "bob@example.test", "member", false],
		]);
	});

	test("members and outsiders cannot list members or invitations", async () => {
		const { t, bob, carol, org } = await seed();
		for (const userId of [bob, carol]) {
			await expect(
				asUser(t, userId).query(api.account.members, { organizationId: org }),
			).rejects.toThrow();
			await expect(
				asUser(t, userId).query(api.account.invitations, {
					organizationId: org,
				}),
			).rejects.toThrow();
		}
	});

	test("admins list only their organization's invitations", async () => {
		const { t, alice, org, invitation } = await seed();
		const invitations = await asUser(t, alice).query(api.account.invitations, {
			organizationId: org,
		});
		expect(invitations).toEqual([
			expect.objectContaining({
				id: invitation,
				email: "dave@example.test",
				role: "admin",
				status: "pending",
			}),
		]);
	});

	test("removing an invitation is scoped to the caller's organization", async () => {
		const { t, alice, bob, org, invitation, otherInvitation } = await seed();
		await expect(
			asUser(t, bob).mutation(api.account.removeInvitation, {
				organizationId: org,
				invitationId: invitation,
			}),
		).rejects.toThrow(/admin/);
		await expect(
			asUser(t, alice).mutation(api.account.removeInvitation, {
				organizationId: org,
				invitationId: otherInvitation,
			}),
		).rejects.toThrow(/not found/);
		await asUser(t, alice).mutation(api.account.removeInvitation, {
			organizationId: org,
			invitationId: invitation,
		});
		expect(
			await asUser(t, alice).query(api.account.invitations, {
				organizationId: org,
			}),
		).toEqual([]);
	});
});
