import type { GenericCtx } from "@convex-dev/better-auth";
import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { APIError } from "better-auth/api";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

// Better Auth's own limiter keys on the client IP, which the web app's proxy
// hides. Sign-in is limited per account and client IP, so a stranger can't
// lock an account out, with a looser per-account ceiling against
// distributed guessing; 2FA per pending sign-in; the rest per account.
export const authRateLimiter = new RateLimiter(components.rateLimiter, {
	signIn: { kind: "fixed window", rate: 10, period: 15 * MINUTE },
	signInAccount: { kind: "fixed window", rate: 100, period: HOUR },
	signUp: { kind: "fixed window", rate: 5, period: HOUR },
	accountEmail: { kind: "fixed window", rate: 5, period: HOUR },
	twoFactor: { kind: "fixed window", rate: 10, period: 15 * MINUTE },
});

type LimitName =
	| "signIn"
	| "signInAccount"
	| "signUp"
	| "accountEmail"
	| "twoFactor";

// Set only by the web app's /api/auth proxy (apps/web/app/api/auth), which
// proves itself with PANARA_CLOUD_PROXY_SECRET: Convex's HTTP endpoint is
// reachable directly, so an unproven client IP header means nothing.
export const CLIENT_IP_HEADER = "x-panara-cloud-client-ip";
export const PROXY_SECRET_HEADER = "x-panara-cloud-proxy-secret";

const sameString = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

export const trustedClientIp = (headers: Headers | undefined) => {
	const secret = process.env.PANARA_CLOUD_PROXY_SECRET;
	const proof = headers?.get(PROXY_SECRET_HEADER);
	if (!secret || !proof || !sameString(proof, secret)) return null;
	const ip = headers?.get(CLIENT_IP_HEADER)?.trim();
	return ip && ip.length <= 64 ? ip : null;
};

const LIMITED_PATHS: Record<string, LimitName> = {
	"/sign-in/email": "signIn",
	"/sign-up/email": "signUp",
	"/request-password-reset": "accountEmail",
	"/send-verification-email": "accountEmail",
	"/two-factor/verify-totp": "twoFactor",
	"/two-factor/verify-backup-code": "twoFactor",
	"/two-factor/verify-otp": "twoFactor",
};

const sha256 = async (value: string) => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
};

const emailOf = (body: unknown) =>
	body &&
	typeof body === "object" &&
	"email" in body &&
	typeof body.email === "string"
		? body.email.trim().toLowerCase()
		: null;

const limitKeys = async (
	name: LimitName,
	body: unknown,
	headers: Headers | undefined,
): Promise<[LimitName, string][]> => {
	const ip = trustedClientIp(headers) ?? "unknown";
	if (name === "twoFactor") {
		// The signed two-factor cookie identifies the pending sign-in; without
		// one, the client IP.
		const cookie = headers?.get("cookie") ?? "";
		const pending =
			/(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=([^;]+)/.exec(
				cookie,
			)?.[1];
		return [
			["twoFactor", pending ? `2fa:${await sha256(pending)}` : `2fa-ip:${ip}`],
		];
	}
	const email = emailOf(body);
	if (!email) return [];
	if (name === "signIn") {
		return [
			["signIn", `email:${email}:ip:${ip}`],
			["signInAccount", `email:${email}`],
		];
	}
	return [[name, `email:${email}`]];
};

// Runs before every auth endpoint; throws 429 once an account's budget for
// the endpoint is spent.
export const enforceAuthRateLimit = async (
	ctx: GenericCtx<DataModel>,
	path: string,
	body: unknown,
	headers: Headers | undefined,
) => {
	const name = LIMITED_PATHS[path];
	if (!name || !("runMutation" in ctx)) return;
	for (const [limit, key] of await limitKeys(name, body, headers)) {
		const { ok, retryAfter } = await authRateLimiter.limit(ctx, limit, {
			key,
		});
		if (!ok) {
			const minutes = Math.max(1, Math.ceil(retryAfter / MINUTE));
			throw new APIError("TOO_MANY_REQUESTS", {
				message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
			});
		}
	}
};
