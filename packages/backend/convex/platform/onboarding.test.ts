import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, bootstrapAdmin, setup } from "../test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "root", "boss", "owner");
	await addMember(t, "root", "helper", "admin");
	await addMember(t, "root", "bob", "member");
	await addMember(t, "other", "eve", "owner");
	await bootstrapAdmin(t, "boss", "boss@example.test");
	return t;
};

const status = (t: Awaited<ReturnType<typeof seed>>, userId: string) =>
	asUser(t, userId).query(api.platform.onboarding.status, {});

describe("panel setup", () => {
	test("is due once, for the instance administrator only", async () => {
		const t = await seed();
		expect(await status(t, "boss")).toEqual({
			isInstanceAdmin: true,
			shouldShowOnboarding: true,
			completedAt: null,
		});
		// Neither another administrator of the root organization, a member, nor
		// the owner of another organization is asked to set up the panel.
		for (const userId of ["helper", "bob", "eve", "stranger"]) {
			expect(await status(t, userId)).toEqual({
				isInstanceAdmin: false,
				shouldShowOnboarding: false,
				completedAt: null,
			});
		}
		expect(await t.query(api.platform.onboarding.status, {})).toBeNull();
	});

	test("finishing or skipping it completes it for good", async () => {
		const t = await seed();
		const boss = asUser(t, "boss");
		await boss.mutation(api.platform.onboarding.complete, {});
		await boss.mutation(api.platform.onboarding.complete, {});
		const after = await status(t, "boss");
		expect(after).toMatchObject({
			isInstanceAdmin: true,
			shouldShowOnboarding: false,
		});
		expect(after?.completedAt).toEqual(expect.any(Number));
		expect(
			await t.run((ctx) => ctx.db.query("onboardingCompletions").collect()),
		).toHaveLength(1);
	});

	test("does not depend on projects or on the organization in view", async () => {
		const t = await seed();
		await addMember(t, "other", "boss", "owner");
		await asUser(t, "boss").mutation(api.projects.create, {
			organizationId: "root",
			name: "Shop",
		});
		expect((await status(t, "boss"))?.shouldShowOnboarding).toBe(true);
	});

	test("nobody else can complete it", async () => {
		const t = await seed();
		await asUser(t, "helper").mutation(api.platform.onboarding.complete, {});
		await asUser(t, "eve").mutation(api.platform.onboarding.complete, {});
		expect(
			await t.run((ctx) => ctx.db.query("onboardingCompletions").collect()),
		).toHaveLength(0);
		expect((await status(t, "boss"))?.shouldShowOnboarding).toBe(true);
		await expect(
			t.mutation(api.platform.onboarding.complete, {}),
		).rejects.toThrow(/Not authenticated/);
	});

	test("an instance administrator who no longer administers the root organization is not asked", async () => {
		const t = await seed();
		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("memberships")
				.withIndex("by_organizationId_and_userId", (q) =>
					q.eq("organizationId", "root").eq("userId", "boss"),
				)
				.unique();
			if (membership) {
				await ctx.db.patch("memberships", membership._id, { role: "member" });
			}
		});
		expect(await status(t, "boss")).toMatchObject({
			isInstanceAdmin: false,
			shouldShowOnboarding: false,
		});
	});

	test("before an instance administrator exists, nobody is asked", async () => {
		const t = setup();
		await addMember(t, "root", "early", "owner");
		expect(await status(t, "early")).toMatchObject({
			shouldShowOnboarding: false,
		});
	});
});
