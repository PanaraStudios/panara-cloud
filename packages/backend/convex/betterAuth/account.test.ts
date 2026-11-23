/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const seed = async () => {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		const user = (email: string) =>
			ctx.db.insert("user", {
				name: email,
				email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			});
		const session = (
			userId: string,
			token: string,
			updatedAt: number,
			expiresAt = now + 60_000,
		) =>
			ctx.db.insert("session", {
				userId,
				token,
				createdAt: now - 10_000,
				updatedAt,
				expiresAt,
				userAgent: "Mozilla/5.0 Chrome/140",
			});
		const alice = await user("alice@example.test");
		const bob = await user("bob@example.test");
		return {
			alice,
			bob,
			aliceCurrent: await session(alice, "token-a1", now),
			aliceLaptop: await session(alice, "token-a2", now - 5_000),
			aliceExpired: await session(alice, "token-a3", now - 9_000, now - 1),
			bobPhone: await session(bob, "token-b1", now),
		};
	});
	return { t, ids };
};

describe("account sessions", () => {
	test("lists live sessions, newest first, without tokens", async () => {
		const { t, ids } = await seed();
		const sessions = await t.query(api.account.listSessions, {
			userId: ids.alice,
			currentSessionId: ids.aliceCurrent,
		});
		expect(sessions.map((s) => [s.id, s.current])).toEqual([
			[ids.aliceCurrent, true],
			[ids.aliceLaptop, false],
		]);
		expect(JSON.stringify(sessions)).not.toContain("token-");
	});

	test("revokes only the user's own, non-current sessions", async () => {
		const { t, ids } = await seed();
		const revoke = (sessionId: string) =>
			t.mutation(api.account.revokeSession, {
				userId: ids.alice,
				sessionId,
				currentSessionId: ids.aliceCurrent,
			});
		expect(await revoke(ids.bobPhone)).toBe(false);
		expect(await revoke(ids.aliceCurrent)).toBe(false);
		expect(await revoke(ids.aliceLaptop)).toBe(true);
		const remaining = await t.run((ctx) => ctx.db.query("session").collect());
		expect(remaining.map((s) => s._id).sort()).toEqual(
			[ids.aliceCurrent, ids.aliceExpired, ids.bobPhone].sort(),
		);
	});

	test("signing out everywhere else keeps the current session and other users' sessions", async () => {
		const { t, ids } = await seed();
		const count = await t.mutation(api.account.revokeOtherSessions, {
			userId: ids.alice,
			currentSessionId: ids.aliceCurrent,
		});
		expect(count).toBe(2);
		const remaining = await t.run((ctx) => ctx.db.query("session").collect());
		expect(remaining.map((s) => s._id).sort()).toEqual(
			[ids.aliceCurrent, ids.bobPhone].sort(),
		);
	});
});
