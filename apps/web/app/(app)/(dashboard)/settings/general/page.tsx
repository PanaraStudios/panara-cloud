import { OrganizationSettings } from "@/components/settings/general-settings";
import { GENERAL_SECTION_URLS } from "@/lib/navigation";
import { param } from "@/lib/redirects/old-routes";
import type { Metadata } from "@/lib/router";
import { redirect, useSearchParams } from "@/lib/router";

export const metadata: Metadata = { title: "General" };

// General was one page with a list of sections; each is now its own page.
export default function Page() {
	const searchParams = useSearchParams();
	const moved = GENERAL_SECTION_URLS[param(searchParams, "section") ?? ""];
	if (moved) redirect(moved);
	return <OrganizationSettings />;
}
