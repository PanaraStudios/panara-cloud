import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OrganizationSettings } from "@/components/settings/general-settings";
import { GENERAL_SECTION_URLS } from "@/lib/navigation";
import { param, type SearchParams } from "@/lib/redirects/old-routes";

export const metadata: Metadata = { title: "General" };

// General was one page with a list of sections; each is now its own page.
export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	const moved =
		GENERAL_SECTION_URLS[(await param(searchParams, "section")) ?? ""];
	if (moved) redirect(moved);
	return <OrganizationSettings />;
}
