import { param } from "@/lib/redirects/old-routes";
import { redirect, useSearchParams } from "@/lib/router";

// The backend's OAuth and GitHub App callbacks send the browser here with
// ?connected or ?error, which the Git page turns into a toast.
export default function Page() {
	const searchParams = useSearchParams();
	const query = new URLSearchParams();
	for (const name of ["connected", "error"]) {
		const value = param(searchParams, name);
		if (value) query.set(name, value);
	}
	redirect(query.size ? `/settings/git?${query}` : "/settings/git");
}
