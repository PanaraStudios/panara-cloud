import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy, HSTS } from "@/lib/csp";
import { NEXT_PATH_HEADER, withNext } from "@/lib/next-path";

// Better Auth appends ?error=<code> to the callback URL when an email link
// is invalid or expired; send those visits to the page that explains it.
const LINK_ERRORS = new Set([
	"INVALID_TOKEN",
	"TOKEN_EXPIRED",
	"USER_NOT_FOUND",
	"INVALID_USER",
]);
const AUTH_PAGES = new Set([
	"/login",
	"/verify-email",
	"/reset-password",
	"/forgot-password",
]);

export function proxy(request: NextRequest) {
	const url = request.nextUrl;
	const error = url.searchParams.get("error");
	if (error && LINK_ERRORS.has(error) && !AUTH_PAGES.has(url.pathname)) {
		const rest = new URLSearchParams(url.searchParams);
		rest.delete("error");
		const query = rest.toString();
		const next = `${url.pathname}${query ? `?${query}` : ""}`;
		const target = new URL(
			withNext(`/verify-email?error=${encodeURIComponent(error)}`, next),
			url,
		);
		return NextResponse.redirect(target);
	}
	const headers = new Headers(request.headers);
	headers.set(NEXT_PATH_HEADER, `${url.pathname}${url.search}`);
	const response = NextResponse.next({ request: { headers } });
	// Set here, not in next.config.ts: config headers are fixed at build time,
	// and the Convex and live URLs are per install.
	response.headers.set(
		"Content-Security-Policy",
		contentSecurityPolicy({
			convexUrl: process.env.CONVEX_PUBLIC_URL,
			liveUrl: process.env.PANARA_CLOUD_LIVE_URL,
			dev: process.env.NODE_ENV === "development",
		}),
	);
	// Traefik terminates TLS and says so in X-Forwarded-Proto.
	const proto =
		request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
		url.protocol.replace(/:$/, "");
	if (proto === "https") {
		response.headers.set("Strict-Transport-Security", HSTS);
	}
	return response;
}

export const config = {
	matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
