import { redirect } from "next/navigation";
import { param, type SearchParams } from "@/lib/redirects/old-routes";

export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	const tab = await param(searchParams, "tab");
	redirect(tab === "deployments" ? "/activity/deployments" : "/");
}
