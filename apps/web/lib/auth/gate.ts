import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/auth/client";
import { safeNext, withNext } from "@/lib/next-path";
import { usePathname, useRouter, useSearchParams } from "@/lib/router";

/**
 * The signed-in account for the dashboard, undefined until it is known. A
 * visitor without a session is sent to sign in, and back here afterwards.
 */
export function useAccount() {
	const { isLoading, isAuthenticated } = useConvexAuth();
	const account = useQuery(api.account.security, isAuthenticated ? {} : "skip");
	const pathname = usePathname();
	const search = useSearchParams().toString();
	const router = useRouter();
	// Checked when the dashboard loads, as the server did before rendering
	// it. After that the page stays as it is with the account it had: a
	// session that rotates (a password or two-factor change) reloads the
	// query, which reads as no account for a moment.
	const last = useRef(account ?? undefined);
	if (account) last.current = account;
	const signedOut =
		last.current === undefined &&
		((!isLoading && !isAuthenticated) || account === null);
	const here = `${pathname}${search ? `?${search}` : ""}`;
	useEffect(() => {
		if (signedOut) router.replace(withNext("/login", here));
	}, [signedOut, here, router]);
	return last.current;
}

/**
 * On the sign-in and sign-up pages: sends a visitor who already has a
 * session on to `?next=`. The form shows meanwhile, as it did when the
 * server checked first: only a signed-in visitor sees it for a moment. The
 * check goes out when the page opens, before the form can be sent, so
 * signing in here never races it; the form moves on by itself.
 */
export function useRedirectIfSignedIn() {
	const next = safeNext(useSearchParams().get("next"));
	const router = useRouter();
	const target = useRef(next);
	useEffect(() => {
		let active = true;
		authClient.getSession().then(
			({ data }) => {
				if (active && data?.session) router.replace(target.current);
			},
			() => {},
		);
		return () => {
			active = false;
		};
	}, [router]);
}
