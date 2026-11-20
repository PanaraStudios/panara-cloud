import "server-only";
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
import { api } from "@panara-cloud/backend/api";
import { ConvexHttpClient } from "convex/browser";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { NEXT_PATH_HEADER, withNext } from "@/lib/next-path";

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} must be set (see apps/web/README.md).`);
	return value;
}

// Constructed per request so no deployment hostnames end up in the bundle.
export function serverAuth() {
	return convexBetterAuthNextJs({
		convexUrl: required("CONVEX_INTERNAL_URL"),
		convexSiteUrl: required("CONVEX_INTERNAL_SITE_URL"),
	});
}

export function publicConvexUrl() {
	return required("CONVEX_PUBLIC_URL");
}

const currentAccount = cache(async () => {
	const token = await serverAuth().getToken();
	if (!token) return null;
	const client = new ConvexHttpClient(required("CONVEX_INTERNAL_URL"));
	client.setAuth(token);
	try {
		return await client.query(api.account.security, {});
	} catch {
		return null;
	}
});

export async function requireAccount() {
	const account = await currentAccount();
	if (!account) {
		const path = (await headers()).get(NEXT_PATH_HEADER) ?? "/";
		redirect(withNext("/login", path));
	}
	return account;
}

export async function redirectIfSignedIn(next: string) {
	if (await serverAuth().isAuthenticated()) redirect(next);
}
