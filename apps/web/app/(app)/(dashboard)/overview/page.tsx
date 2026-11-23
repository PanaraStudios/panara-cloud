import { param } from "@/lib/redirects/old-routes";
import { redirect, useSearchParams } from "@/lib/router";

export default function Page() {
	const searchParams = useSearchParams();
	const tab = param(searchParams, "tab");
	redirect(tab === "deployments" ? "/activity/deployments" : "/");
}
