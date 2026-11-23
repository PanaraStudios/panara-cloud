import { withNext } from "./next-path.ts";

// Better Auth appends ?error=<code> to the callback URL when an email link
// is invalid or expired; those visits go to the page that explains it.
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

export function linkErrorRedirect(
	pathname: string,
	searchParams: URLSearchParams,
): string | null {
	const error = searchParams.get("error");
	if (!error || !LINK_ERRORS.has(error) || AUTH_PAGES.has(pathname)) {
		return null;
	}
	const rest = new URLSearchParams(searchParams);
	rest.delete("error");
	const query = rest.toString();
	const next = `${pathname}${query ? `?${query}` : ""}`;
	return withNext(`/verify-email?error=${encodeURIComponent(error)}`, next);
}
