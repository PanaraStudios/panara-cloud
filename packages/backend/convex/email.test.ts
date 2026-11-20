import rateLimiter from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import {
	addMember,
	asUser,
	SITE_URL,
	setup,
	type TestConvex,
} from "./test.setup";

const PASSWORD = "correct horse battery";
const SITE = "http://localhost:3000";

const authSetup = () => {
	const t = setup();
	rateLimiter.register(t);
	return t;
};

const signUp = (
	t: TestConvex,
	body: {
		email: string;
		invitationId?: string;
		callbackURL?: string;
		setupToken?: string;
	},
) =>
	t.fetch("/api/auth/sign-up/email", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: SITE },
		body: JSON.stringify({ name: "Someone", password: PASSWORD, ...body }),
	});

const signIn = (t: TestConvex, email: string) =>
	t.fetch("/api/auth/sign-in/email", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: SITE },
		body: JSON.stringify({ email, password: PASSWORD }),
	});

const userByEmail = (t: TestConvex, email: string) =>
	t.run(
		(ctx) =>
			ctx.runQuery(components.betterAuth.adapter.findOne, {
				model: "user",
				where: [{ field: "email", value: email }],
			}) as Promise<{ _id: string; emailVerified: boolean } | null>,
	);

const invite = (
	t: TestConvex,
	email: string,
	expiresAt = Date.now() + 60_000,
) =>
	t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "invitation",
			data: {
				organizationId: "org",
				email,
				role: "member",
				status: "pending",
				expiresAt,
				createdAt: Date.now(),
				inviterId: "admin",
			},
		} as never,
	}) as Promise<{ _id: string }>;

const connectProvider = async (t: TestConvex, adminId: string) => {
	await asUser(t, adminId).action(api.email.saveProvider, {
		provider: "opensend",
		from: "Panara Cloud <no-reply@mail.example.com>",
		apiKey: "os_test_secret_key_1234",
	});
};

const setupToken = async (t: TestConvex) => {
	const { url } = await t.action(internal.install.setupLink, {});
	return new URL(url).searchParams.get("setup") ?? "";
};

const firstAdmin = async (t: TestConvex) => {
	const token = await setupToken(t);
	expect(
		(await signUp(t, { email: "admin@example.test", setupToken: token }))
			.status,
	).toBe(200);
	const admin = await userByEmail(t, "admin@example.test");
	if (!admin) throw new Error("admin missing");
	return admin._id;
};

// An identity backed by a real Better Auth session, as the web app sends.
const withSession = async (t: TestConvex, userId: string, email: string) => {
	await signIn(t, email);
	const session = (await t.run((ctx) =>
		ctx.runQuery(components.betterAuth.adapter.findOne, {
			model: "session",
			where: [{ field: "userId", value: userId }],
		}),
	)) as { _id: string };
	return t.withIdentity({
		subject: userId,
		issuer: SITE_URL,
		sessionId: session._id,
	});
};

let logLinks: string | undefined;
beforeEach(() => {
	logLinks = process.env.LOG_AUTH_LINKS;
	delete process.env.LOG_AUTH_LINKS;
	delete process.env.RESEND_API_KEY;
	process.env.SITE_URL = SITE;
	process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123";
});
afterEach(() => {
	if (logLinks !== undefined) process.env.LOG_AUTH_LINKS = logLinks;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the first account (setup link)", () => {
	const message = async (response: Response) =>
		((await response.json()) as { message: string }).message;
	const adminOf = (t: TestConvex) =>
		t.query(components.betterAuth.policy.instanceAdminUserId, {});

	test("a sign-up without the setup token is refused", async () => {
		const t = authSetup();
		await setupToken(t);
		const response = await signUp(t, { email: "early@example.test" });
		expect(response.status).toBe(400);
		expect(await message(response)).toMatch(/setup link/);
		expect(await userByEmail(t, "early@example.test")).toBeNull();
		expect(await adminOf(t)).toBeNull();
	});

	test("a wrong or replaced setup token is refused", async () => {
		const t = authSetup();
		const old = await setupToken(t);
		await setupToken(t);
		for (const token of ["not-the-token", old]) {
			const response = await signUp(t, {
				email: "early@example.test",
				setupToken: token,
			});
			expect(response.status).toBe(400);
			expect(await message(response)).toMatch(
				/invalid, expired or already used/,
			);
		}
		expect(await userByEmail(t, "early@example.test")).toBeNull();
		expect(await adminOf(t)).toBeNull();
	});

	test("an expired setup token is refused", async () => {
		const t = authSetup();
		const token = await setupToken(t);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
		const response = await signUp(t, {
			email: "admin@example.test",
			setupToken: token,
		});
		expect(response.status).toBe(400);
		expect(await adminOf(t)).toBeNull();
	});

	test("the setup token creates the administrator once", async () => {
		const t = authSetup();
		const token = await setupToken(t);
		const adminId = await (async () => {
			const response = await signUp(t, {
				email: "admin@example.test",
				setupToken: token,
			});
			expect(response.status).toBe(200);
			return (await userByEmail(t, "admin@example.test"))?._id;
		})();
		expect(await adminOf(t)).toBe(adminId);
		const again = await signUp(t, {
			email: "second@example.test",
			setupToken: token,
		});
		expect(again.status).toBe(400);
		expect(await userByEmail(t, "second@example.test")).toBeNull();
		expect(await adminOf(t)).toBe(adminId);
		await expect(t.action(internal.install.setupLink, {})).rejects.toThrow(
			"already has an administrator",
		);
	});

	test("invited sign-ups after setup are unaffected", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		const { _id } = await invite(t, "new@example.test");
		const response = await signUp(t, {
			email: "new@example.test",
			invitationId: _id,
		});
		expect(response.status).toBe(200);
		expect(await adminOf(t)).toBe(adminId);
	});
});

describe("instances without email", () => {
	test("the first account signs up without verification and administers the instance", async () => {
		const t = authSetup();
		expect(await t.query(api.email.status, {})).toEqual({ enabled: false });
		const adminId = await firstAdmin(t);
		expect((await userByEmail(t, "admin@example.test"))?.emailVerified).toBe(
			true,
		);
		expect(
			await t.query(components.betterAuth.policy.isInstanceAdmin, {
				userId: adminId,
			}),
		).toBe(true);
		expect((await signIn(t, "admin@example.test")).status).toBe(200);
	});

	test("an invitation link admits its email without verification", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const { _id } = await invite(t, "new@example.test");
		const response = await signUp(t, {
			email: "new@example.test",
			invitationId: _id,
		});
		expect(response.status).toBe(200);
		expect((await userByEmail(t, "new@example.test"))?.emailVerified).toBe(
			true,
		);
		expect((await signIn(t, "new@example.test")).status).toBe(200);
	});

	test("an invitation id for another email doesn't verify", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const { _id } = await invite(t, "invited@example.test");
		await invite(t, "other@example.test");
		const response = await signUp(t, {
			email: "other@example.test",
			invitationId: _id,
		});
		expect(response.status).toBe(400);
		expect(await userByEmail(t, "other@example.test")).toBeNull();
	});

	test("sign-ups without an invitation link are refused", async () => {
		const t = authSetup();
		await firstAdmin(t);
		await invite(t, "invited@example.test");
		const response = await signUp(t, { email: "invited@example.test" });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toMatch(
			/doesn't send email/,
		);
		expect((await signUp(t, { email: "stranger@example.test" })).status).toBe(
			400,
		);
		expect(await userByEmail(t, "stranger@example.test")).toBeNull();
	});

	test("password reset requests explain that no email is sent", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const response = await t.fetch("/api/auth/request-password-reset", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: SITE },
			body: JSON.stringify({ email: "admin@example.test" }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toMatch(
			/reset link/,
		);
	});

	test("invitations return a link to copy instead of emailing", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		await addMember(t, "org", adminId, "owner");
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: "organization",
				data: { name: "Acme", slug: "acme", createdAt: Date.now() },
			} as never,
		});
		const org = await t.run(
			(ctx) =>
				ctx.runQuery(components.betterAuth.adapter.findOne, {
					model: "organization",
					where: [{ field: "slug", value: "acme" }],
				}) as Promise<{ _id: string }>,
		);
		await addMember(t, org._id, adminId, "owner");
		const result = await asUser(t, adminId).action(api.users.invite, {
			organizationId: org._id,
			email: "teammate@example.test",
			role: "member",
		});
		expect(result.emailed).toBe(false);
		expect(result.emailError).toBeNull();
		expect(result.url).toBe(
			`${SITE}/invitation?id=${encodeURIComponent(result.invitationId)}`,
		);
	});

	test("an administrator's reset link lets the member choose a new password", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		const { _id } = await invite(t, "member@example.test");
		await signUp(t, { email: "member@example.test", invitationId: _id });
		const member = await userByEmail(t, "member@example.test");
		if (!member) throw new Error("member missing");
		await addMember(t, "org", adminId, "owner");
		await addMember(t, "org", member._id, "member");

		await expect(
			asUser(t, member._id).action(api.users.passwordResetLink, {
				organizationId: "org",
				userId: adminId,
			}),
		).rejects.toThrow();
		const { url } = await asUser(t, adminId).action(
			api.users.passwordResetLink,
			{ organizationId: "org", userId: member._id },
		);
		const token = new URL(url).searchParams.get("token");
		expect(url.startsWith(`${SITE}/reset-password?token=`)).toBe(true);
		const reset = await t.fetch("/api/auth/reset-password", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: SITE },
			body: JSON.stringify({
				token,
				newPassword: "a brand new password",
			}),
		});
		expect(reset.status).toBe(200);
		const again = await t.fetch("/api/auth/sign-in/email", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: SITE },
			body: JSON.stringify({
				email: "member@example.test",
				password: "a brand new password",
			}),
		});
		expect(again.status).toBe(200);
	});

	test("email changes apply directly after a recent sign-in", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const t = authSetup();
		const adminId = await firstAdmin(t);
		const asAdmin = await withSession(t, adminId, "admin@example.test");
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: "user",
				data: {
					name: "taken",
					email: "taken@example.test",
					emailVerified: true,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			} as never,
		});
		await expect(
			asAdmin.mutation(api.account.changeEmailWithoutConfirmation, {
				newEmail: "taken@example.test",
			}),
		).rejects.toThrow("already has an account");
		await asAdmin.mutation(api.account.changeEmailWithoutConfirmation, {
			newEmail: "New@Example.test",
		});
		expect(await userByEmail(t, "new@example.test")).not.toBeNull();
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		await expect(
			asAdmin.mutation(api.account.changeEmailWithoutConfirmation, {
				newEmail: "later@example.test",
			}),
		).rejects.toThrow("recent sign-in");
	});

	test("an unproven address can't capture invitations sent to it", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const { _id: orgX } = (await t.mutation(
			components.betterAuth.adapter.create,
			{
				input: {
					model: "organization",
					data: { name: "X", slug: "x", createdAt: Date.now() },
				},
			} as never,
		)) as { _id: string };
		const inviteTo = (email: string) =>
			t.mutation(components.betterAuth.adapter.create, {
				input: {
					model: "invitation",
					data: {
						organizationId: orgX,
						email,
						role: "admin",
						status: "pending",
						expiresAt: Date.now() + 60_000,
						createdAt: Date.now(),
						inviterId: "admin",
					},
				},
			} as never) as Promise<{ _id: string }>;
		const { _id } = await invite(t, "member@example.test");
		await signUp(t, { email: "member@example.test", invitationId: _id });
		const member = await userByEmail(t, "member@example.test");
		if (!member) throw new Error("member missing");
		const asMember = await withSession(t, member._id, "member@example.test");

		// An address with a pending invitation can't be taken.
		await inviteTo("victim@example.test");
		await expect(
			asMember.mutation(api.account.changeEmailWithoutConfirmation, {
				newEmail: "victim@example.test",
			}),
		).rejects.toThrow("pending invitation");

		// One claimed first doesn't list invitations sent to it later.
		await asMember.mutation(api.account.changeEmailWithoutConfirmation, {
			newEmail: "later@example.test",
		});
		await inviteTo("later@example.test");
		const login = await signIn(t, "later@example.test");
		const cookie = (login.headers.getSetCookie?.() ?? [])
			.map((c) => c.split(";")[0])
			.join("; ");
		const list = await t.fetch("/api/auth/organization/list-user-invitations", {
			headers: { Origin: SITE, Cookie: cookie },
		});
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual([]);
	});

	test("a proven address still lists its invitations", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const { _id } = await invite(t, "member@example.test");
		await signUp(t, { email: "member@example.test", invitationId: _id });
		const { _id: second } = await invite(t, "member@example.test");
		const login = await signIn(t, "member@example.test");
		const cookie = (login.headers.getSetCookie?.() ?? [])
			.map((c) => c.split(";")[0])
			.join("; ");
		const list = await t.fetch("/api/auth/organization/list-user-invitations", {
			headers: { Origin: SITE, Cookie: cookie },
		});
		expect(list.status).toBe(200);
		const invitations = (await list.json()) as { id: string }[];
		expect(invitations.map((i) => i.id)).toContain(second);
	});

	test("the installer prints a reset link for any account", async () => {
		const t = authSetup();
		await firstAdmin(t);
		const { url } = await t.action(internal.install.passwordResetLink, {
			email: "ADMIN@example.test",
		});
		expect(url).toMatch(/\/reset-password\?token=/);
		await expect(
			t.action(internal.install.passwordResetLink, {
				email: "nobody@example.test",
			}),
		).rejects.toThrow("No account");
	});
});

describe("email provider settings", () => {
	test("only the instance administrator can configure it; the key stays encrypted", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		const { _id } = await invite(t, "member@example.test");
		await signUp(t, { email: "member@example.test", invitationId: _id });
		const member = await userByEmail(t, "member@example.test");
		if (!member) throw new Error("member missing");

		await expect(connectProvider(t, member._id)).rejects.toThrow(
			"instance administrator",
		);
		await expect(
			asUser(t, member._id).query(api.email.settings, {}),
		).rejects.toThrow("instance administrator");
		await expect(
			asUser(t, member._id).mutation(api.email.disconnect, {}),
		).rejects.toThrow("instance administrator");

		await connectProvider(t, adminId);
		const settings = await asUser(t, adminId).query(api.email.settings, {});
		expect(settings.mode).toBe("provider");
		expect(settings.provider).toMatchObject({
			provider: "opensend",
			apiKeyHint: "1234",
			defaultBaseUrl: "https://api.opensend.cc",
		});
		expect(JSON.stringify(settings)).not.toContain("os_test_secret");
		const stored = await t.run((ctx) => ctx.db.query("secrets").collect());
		expect(stored).toHaveLength(1);
		expect(stored[0]?.ciphertext).not.toContain("os_test_secret");
		expect(await t.query(api.email.status, {})).toEqual({ enabled: true });

		await asUser(t, adminId).mutation(api.email.disconnect, {});
		expect(await t.query(api.email.status, {})).toEqual({ enabled: false });
		expect(await t.run((ctx) => ctx.db.query("secrets").collect())).toEqual([]);
	});

	test("with a provider, sign-ups need verification and mail goes through its API", async () => {
		vi.useFakeTimers();
		const t = authSetup();
		const adminId = await firstAdmin(t);
		await connectProvider(t, adminId);
		await asUser(t, adminId).action(api.email.saveProvider, {
			provider: "opensend",
			from: "Panara Cloud <no-reply@mail.example.com>",
			baseUrl: "https://mail.internal.example.com/",
		});
		const requests: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				requests.push({ url, init });
				return requests.length === 1
					? new Response(JSON.stringify({ message: "slow down" }), {
							status: 429,
							headers: { "retry-after": "1" },
						})
					: Response.json({ id: "email_1" });
			}),
		);
		await invite(t, "invited@acme.dev");
		const response = await signUp(t, { email: "invited@acme.dev" });
		expect(response.status).toBe(200);
		expect((await userByEmail(t, "invited@acme.dev"))?.emailVerified).toBe(
			false,
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(requests).toHaveLength(2);
		const [first, second] = requests;
		expect(first?.url).toBe("https://mail.internal.example.com/emails");
		const headers = new Headers(first?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer os_test_secret_key_1234");
		expect(headers.get("idempotency-key")).toBe(
			new Headers(second?.init.headers).get("idempotency-key"),
		);
		const body = JSON.parse(String(first?.init.body));
		expect(body).toMatchObject({
			from: "Panara Cloud <no-reply@mail.example.com>",
			to: ["invited@acme.dev"],
			subject: "Verify your email",
		});
		const settings = await asUser(t, adminId).query(api.email.settings, {});
		expect(settings.provider?.lastSentAt).not.toBeNull();
		expect(settings.provider?.lastError).toBeNull();
	});

	test("with a provider, direct email changes are refused and invitations are emailed", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		await connectProvider(t, adminId);
		await expect(
			(await withSession(t, adminId, "admin@example.test")).mutation(
				api.account.changeEmailWithoutConfirmation,
				{
					newEmail: "x@acme.dev",
				},
			),
		).rejects.toThrow("sends email");
		await addMember(t, "org", adminId, "owner");
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: "organization",
				data: { name: "Acme", slug: "acme", createdAt: Date.now() },
			} as never,
		});
		const org = (await t.run((ctx) =>
			ctx.runQuery(components.betterAuth.adapter.findOne, {
				model: "organization",
				where: [{ field: "slug", value: "acme" }],
			}),
		)) as { _id: string };
		await addMember(t, org._id, adminId, "owner");
		const result = await asUser(t, adminId).action(api.users.invite, {
			organizationId: org._id,
			email: "teammate@acme.dev",
			role: "member",
		});
		expect(result).toMatchObject({ emailed: true, emailError: null });
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled.map((job) => job.name)).toContain("email:deliver");
	});

	test("the test email goes to the administrator and reports provider errors", async () => {
		const t = authSetup();
		const adminId = await firstAdmin(t);
		await connectProvider(t, adminId);
		const fetchMock = vi.fn(async () =>
			Response.json(
				{
					statusCode: 403,
					name: "invalid_api_key",
					message: "API key is invalid",
				},
				{ status: 403 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await asUser(t, adminId).action(api.email.sendTest, {});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/403: API key is invalid/);
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(JSON.parse(String(init.body)).to).toEqual(["admin@example.test"]);
		const settings = await asUser(t, adminId).query(api.email.settings, {});
		expect(settings.provider?.lastError).toMatch(/API key is invalid/);
	});
});
