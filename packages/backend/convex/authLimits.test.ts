import rateLimiter from "@convex-dev/rate-limiter/test";
import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import {
	authRateLimiter,
	CLIENT_IP_HEADER,
	PROXY_SECRET_HEADER,
} from "./authLimits";
import { setup, type TestConvex } from "./test.setup";

const SITE = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const EMAIL = "admin@example.test";
const PROXY_SECRET = "proxy-secret-for-tests";

const post = (
	t: TestConvex,
	path: string,
	body: object,
	headers: Record<string, string> = {},
) =>
	t.fetch(`/api/auth${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: SITE, ...headers },
		body: JSON.stringify(body),
	});

const viaProxy = (ip: string) => ({
	[PROXY_SECRET_HEADER]: PROXY_SECRET,
	[CLIENT_IP_HEADER]: ip,
});

const signIn = (
	t: TestConvex,
	password: string,
	headers: Record<string, string> = {},
) => post(t, "/sign-in/email", { email: EMAIL, password }, headers);

const withAdmin = async () => {
	const t = setup();
	rateLimiter.register(t);
	const { url } = await t.action(internal.install.setupLink, {});
	const response = await post(t, "/sign-up/email", {
		name: "Admin",
		email: EMAIL,
		password: PASSWORD,
		setupToken: new URL(url).searchParams.get("setup"),
	});
	expect(response.status).toBe(200);
	return t;
};

beforeEach(() => {
	delete process.env.LOG_AUTH_LINKS;
	delete process.env.RESEND_API_KEY;
	process.env.SITE_URL = SITE;
	process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123";
	process.env.PANARA_CLOUD_PROXY_SECRET = PROXY_SECRET;
});

describe("sign-in limits", () => {
	test("failed sign-ins from one client don't lock the account out for another", async () => {
		const t = await withAdmin();
		for (let i = 0; i < 10; i++) {
			expect(
				(await signIn(t, "wrong password!!", viaProxy("198.51.100.7"))).status,
			).toBe(401);
		}
		expect((await signIn(t, PASSWORD, viaProxy("198.51.100.7"))).status).toBe(
			429,
		);
		expect((await signIn(t, PASSWORD, viaProxy("203.0.113.9"))).status).toBe(
			200,
		);
	});

	test("a client IP header without the proxy secret is ignored", async () => {
		const t = await withAdmin();
		for (let i = 0; i < 10; i++) {
			const forged = {
				[PROXY_SECRET_HEADER]: "guess",
				[CLIENT_IP_HEADER]: `192.0.2.${i}`,
			};
			expect((await signIn(t, "wrong password!!", forged)).status).toBe(401);
		}
		expect(
			(
				await signIn(t, PASSWORD, {
					[CLIENT_IP_HEADER]: "192.0.2.200",
				})
			).status,
		).toBe(429);
		// The administrator's own client, through the proxy, is unaffected.
		expect((await signIn(t, PASSWORD, viaProxy("203.0.113.9"))).status).toBe(
			200,
		);
	});

	test("the per-account ceiling bounds guessing from many clients", async () => {
		const t = await withAdmin();
		// What 100 failed sign-ins from different clients leave behind (each
		// one runs the password hash, too slow to do here).
		await t.run((ctx) =>
			authRateLimiter.limit(ctx, "signInAccount", {
				key: `email:${EMAIL}`,
				count: 100,
			}),
		);
		expect((await signIn(t, PASSWORD, viaProxy("203.0.113.9"))).status).toBe(
			429,
		);
	});

	test("two-factor verification is limited without a pending sign-in cookie", async () => {
		const t = await withAdmin();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			statuses.push(
				(
					await post(
						t,
						"/two-factor/verify-totp",
						{ code: "000000" },
						viaProxy("198.51.100.7"),
					)
				).status,
			);
		}
		expect(statuses.slice(0, 10)).not.toContain(429);
		expect(statuses[10]).toBe(429);
	});
});
