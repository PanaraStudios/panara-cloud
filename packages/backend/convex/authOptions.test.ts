import { createEmailVerificationToken } from "better-auth/api";
import { describe, expect, test, vi } from "vitest";
import type { AuthEmail } from "./authEmail";
import { createAuthOptions, isChangeEmailVerification } from "./authOptions";

const SECRET = "a-test-secret-that-is-long-enough-for-hs256";
const user = (emailVerified: boolean) => ({
	id: "user1",
	email: "new@example.test",
	emailVerified,
	name: "Test",
	createdAt: new Date(),
	updatedAt: new Date(),
});

describe("sendVerificationEmail", () => {
	const setup = () => {
		const sent: AuthEmail[] = [];
		const options = createAuthOptions(async (email) => {
			sent.push(email);
		});
		const send = options.emailVerification?.sendVerificationEmail;
		if (!send) throw new Error("sendVerificationEmail missing");
		return { sent, send: vi.fn(send) };
	};

	test("skips accounts that are already verified (invitation sign-ups)", async () => {
		const { sent, send } = setup();
		const token = await createEmailVerificationToken(
			SECRET,
			"new@example.test",
			undefined,
			3600,
			{ userId: "user1" },
		);
		await send({ user: user(true), url: "https://x/verify", token });
		expect(sent).toEqual([]);
	});

	test("mails unverified accounts", async () => {
		const { sent, send } = setup();
		const token = await createEmailVerificationToken(
			SECRET,
			"new@example.test",
		);
		await send({ user: user(false), url: "https://x/verify", token });
		expect(sent).toEqual([
			{ to: "new@example.test", kind: "verify", url: "https://x/verify" },
		]);
	});

	test("mails the new address of a verified account changing its email", async () => {
		const { sent, send } = setup();
		const token = await createEmailVerificationToken(
			SECRET,
			"old@example.test",
			"new@example.test",
			3600,
			{ requestType: "change-email-verification", userId: "user1" },
		);
		expect(isChangeEmailVerification(token)).toBe(true);
		await send({ user: user(true), url: "https://x/verify", token });
		expect(sent).toEqual([
			{ to: "new@example.test", kind: "verify", url: "https://x/verify" },
		]);
	});

	test("treats malformed tokens as ordinary verification", () => {
		expect(isChangeEmailVerification("not-a-jwt")).toBe(false);
		expect(isChangeEmailVerification("a.%%%.c")).toBe(false);
	});
});
