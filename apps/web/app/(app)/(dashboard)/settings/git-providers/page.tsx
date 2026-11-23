import { redirect } from "next/navigation";
import { param, type SearchParams } from "@/lib/redirects/old-routes";

// The backend's OAuth and GitHub App callbacks send the browser here with
// ?connected or ?error, which the Git page turns into a toast.
export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	const query = new URLSearchParams();
	for (const name of ["connected", "error"]) {
		const value = await param(searchParams, name);
		if (value) query.set(name, value);
	}
	redirect(query.size ? `/settings/git?${query}` : "/settings/git");
}
