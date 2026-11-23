/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { sha256Hex } from "./policy";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const setup = () => convexTest(schema, modules);

const addUser = (t: ReturnType<typeof setup>, email: string, verified = true) =>
	t.run((ctx) =>
		ctx.db.insert("user", {
			name: email,
			email,
			emailVerified: verified,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);

const TOKEN = "setup-token";

const issue = async (t: ReturnType<typeof setup>, expiresIn = 60_000) =>
	t.mutation(api.policy.issueSetupToken, {
		tokenHash: await sha256Hex(TOKEN),
		expiresAt: Date.now() + expiresIn,
	});

// What a sign-up through the setup link does: reserve (before the insert),
// admit (user trigger), complete (credential account trigger).
const bootstrap = async (
	t: ReturnType<typeof setup>,
	userId: string,
	email: string,
) => {
	await t.mutation(api.policy.reserveSetup, { token: TOKEN, email });
	await t.mutation(api.policy.admitUser, { userId, email });
	await t.mutation(api.policy.completeSetup, {
		userId,
		providerId: "credential",
	});
};

const setupRow = (t: ReturnType<typeof setup>) =>
	t.run((ctx) => ctx.db.query("setupToken").first());

describe("registration policy", () => {
	test("the first account needs the setup token; later ones need an invitation", async () => {
		const t = setup();
		await issue(t);
		expect(await t.query(api.policy.registrationOpen, {})).toBe(true);
		await bootstrap(t, "owner", "owner@example.test");
		expect(await t.query(api.policy.registrationOpen, {})).toBe(false);
		expect(await t.query(api.policy.isInstanceAdmin, { userId: "owner" })).toBe(
			true,
		);
		expect(await setupRow(t)).toBeNull();
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "b",
				email: "b@example.test",
			}),
		).rejects.toThrow("invitation");
		await expect(issue(t)).rejects.toThrow("already has an administrator");
	});

	test("without a reservation for its email the first sign-up is refused", async () => {
		const t = setup();
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "a",
				email: "a@example.test",
			}),
		).rejects.toThrow("setup link");
		await issue(t);
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "a",
				email: "a@example.test",
			}),
		).rejects.toThrow("setup link");
		await t.mutation(api.policy.reserveSetup, {
			token: TOKEN,
			email: "owner@example.test",
		});
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "a",
				email: "a@example.test",
			}),
		).rejects.toThrow("setup link");
		expect(await t.query(api.policy.registrationOpen, {})).toBe(true);
	});

	test("wrong and expired tokens can't be reserved", async () => {
		const t = setup();
		await expect(
			t.mutation(api.policy.reserveSetup, { token: TOKEN, email: "a@x.test" }),
		).rejects.toThrow("invalid");
		await issue(t);
		await expect(
			t.mutation(api.policy.reserveSetup, {
				token: "guess",
				email: "a@x.test",
			}),
		).rejects.toThrow("invalid");
		await issue(t, -1);
		await expect(
			t.mutation(api.policy.reserveSetup, { token: TOKEN, email: "a@x.test" }),
		).rejects.toThrow("invalid");
	});

	test("only one of two concurrent first sign-ups becomes the administrator", async () => {
		const t = setup();
		await issue(t);
		await t.mutation(api.policy.reserveSetup, {
			token: TOKEN,
			email: "a@example.test",
		});
		const results = await Promise.allSettled(
			["a1", "a2"].map((userId) =>
				t.mutation(api.policy.admitUser, {
					userId,
					email: "a@example.test",
				}),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	});

	test("a sign-up that fails before its password is stored leaves no administrator and can be retried", async () => {
		const t = setup();
		await issue(t);
		const half = await addUser(t, "owner@example.test");
		await t.mutation(api.policy.reserveSetup, {
			token: TOKEN,
			email: "owner@example.test",
		});
		await t.mutation(api.policy.admitUser, {
			userId: half,
			email: "owner@example.test",
		});
		expect(await t.query(api.policy.registrationOpen, {})).toBe(true);
		expect(await t.query(api.policy.instanceAdminUserId, {})).toBeNull();
		// The retry removes the password-less user row and starts over.
		await t.mutation(api.policy.reserveSetup, {
			token: TOKEN,
			email: "owner@example.test",
		});
		expect(await t.run((ctx) => ctx.db.get("user", half))).toBeNull();
		const owner = await addUser(t, "owner@example.test");
		await t.mutation(api.policy.admitUser, {
			userId: owner,
			email: "owner@example.test",
		});
		await t.mutation(api.policy.completeSetup, {
			userId: owner,
			providerId: "credential",
		});
		expect(await t.query(api.policy.instanceAdminUserId, {})).toBe(owner);
	});

	test("createInitialAdmin (install.sh create-admin) uses up a pending setup token", async () => {
		const t = setup();
		await issue(t);
		await t.mutation(api.policy.createInitialAdmin, {
			email: "admin@example.test",
			name: "admin",
			passwordHash: "hash",
		});
		expect(await setupRow(t)).toBeNull();
		await expect(
			t.mutation(api.policy.reserveSetup, { token: TOKEN, email: "x@x.test" }),
		).resolves.toBeNull();
		await expect(
			t.mutation(api.policy.admitUser, { userId: "x", email: "x@x.test" }),
		).rejects.toThrow("invitation");
	});

	test("an invited email may sign up only while the invitation is pending and unexpired", async () => {
		const t = setup();
		await issue(t);
		await bootstrap(t, "owner", "owner@example.test");
		const invite = (email: string, status: string, expiresAt: number) =>
			t.run((ctx) =>
				ctx.db.insert("invitation", {
					organizationId: "org",
					email,
					role: "member",
					status,
					expiresAt,
					createdAt: Date.now(),
					inviterId: "owner",
				}),
			);
		await invite("expired@example.test", "pending", Date.now() - 1000);
		await invite("revoked@example.test", "canceled", Date.now() + 60_000);
		await invite("invited@example.test", "pending", Date.now() + 60_000);
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "x",
				email: "expired@example.test",
			}),
		).rejects.toThrow("invitation");
		await expect(
			t.mutation(api.policy.admitUser, {
				userId: "y",
				email: "revoked@example.test",
			}),
		).rejects.toThrow("invitation");
		await t.mutation(api.policy.admitUser, {
			userId: "z",
			email: "Invited@Example.test",
		});
	});
});

describe("operator recovery", () => {
	test("transferring the administrator role requires a verified account", async () => {
		const t = setup();
		const owner = await addUser(t, "owner@example.test");
		await issue(t);
		await bootstrap(t, owner, "owner@example.test");
		await addUser(t, "unverified@example.test", false);
		const next = await addUser(t, "next@example.test");
		await expect(
			t.mutation(api.policy.transferInstanceAdmin, {
				email: "unverified@example.test",
			}),
		).rejects.toThrow("verified");
		await t.mutation(api.policy.transferInstanceAdmin, {
			email: "next@example.test",
		});
		expect(await t.query(api.policy.isInstanceAdmin, { userId: next })).toBe(
			true,
		);
		expect(await t.query(api.policy.isInstanceAdmin, { userId: owner })).toBe(
			false,
		);
	});

	test("resetting two-factor removes the factor and signs the user out", async () => {
		const t = setup();
		const userId = await addUser(t, "locked@example.test");
		await t.run(async (ctx) => {
			await ctx.db.patch("user", userId, { twoFactorEnabled: true });
			await ctx.db.insert("twoFactor", {
				secret: "s",
				backupCodes: "c",
				userId,
			});
			await ctx.db.insert("session", {
				userId,
				token: "t",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				expiresAt: Date.now() + 60_000,
			});
		});
		await t.mutation(api.policy.resetTwoFactor, {
			email: "locked@example.test",
		});
		const state = await t.run(async (ctx) => ({
			user: await ctx.db.get("user", userId),
			factors: await ctx.db.query("twoFactor").collect(),
			sessions: await ctx.db.query("session").collect(),
		}));
		expect(state.user?.twoFactorEnabled).toBe(false);
		expect(state.factors).toHaveLength(0);
		expect(state.sessions).toHaveLength(0);
	});
});
