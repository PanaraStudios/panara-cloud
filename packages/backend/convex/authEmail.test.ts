import { afterEach, describe, expect, test, vi } from "vitest";
import { components, internal } from "./_generated/api";
import { INVITATION_REQUIRED, NO_EMAIL_MESSAGES } from "./authEmail";
import { bootstrapAdmin, setup, type TestConvex } from "./test.setup";

const invite = (t: TestConvex, email: string) =>
	t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "invitation",
			data: {
				organizationId: "org",
				email,
				role: "member",
				status: "pending",
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				inviterId: "owner",
			},
		} as never,
	});

const policy = (t: TestConvex, email: string) =>
	t.query(internal.authEmail.signupPolicy, { email });

describe("sign-up policy", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("an uninvited sign-up is refused for lacking an invitation, with or without email", async () => {
		vi.stubEnv("LOG_AUTH_LINKS", "false");
		const t = setup();
		await bootstrapAdmin(t, "owner", "owner@example.test");
		expect((await policy(t, "stranger@example.test")).refusal).toEqual({
			code: "INVITATION_REQUIRED",
			message: INVITATION_REQUIRED,
		});
		vi.stubEnv("LOG_AUTH_LINKS", "true");
		expect((await policy(t, "stranger@example.test")).refusal?.code).toBe(
			"INVITATION_REQUIRED",
		);
	});

	test("an invited address without its link is refused only when nothing can verify it", async () => {
		vi.stubEnv("LOG_AUTH_LINKS", "false");
		const t = setup();
		await bootstrapAdmin(t, "owner", "owner@example.test");
		await invite(t, "invited@example.test");
		expect((await policy(t, "Invited@example.test")).refusal).toEqual({
			code: "EMAIL_UNAVAILABLE",
			message: NO_EMAIL_MESSAGES.verify,
		});
		vi.stubEnv("LOG_AUTH_LINKS", "true");
		expect(await policy(t, "invited@example.test")).toEqual({
			verified: false,
			refusal: null,
			setup: false,
		});
	});
});
