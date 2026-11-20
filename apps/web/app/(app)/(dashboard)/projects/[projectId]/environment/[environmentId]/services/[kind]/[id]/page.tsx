import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ServiceOverview } from "@/components/service/overview";
import {
	isServiceKind,
	sectionForLegacyTab,
	serviceUrl,
} from "@/lib/navigation";

export const metadata: Metadata = { title: "Service" };

export default async function Page({
	params,
	searchParams,
}: {
	params: Promise<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>;
	searchParams: Promise<{ tab?: string | string[] }>;
}) {
	const { projectId, environmentId, kind, id } = await params;
	const { tab } = await searchParams;
	// Older links point at sections with `?tab=`; send them to the section's path.
	if (typeof tab === "string" && isServiceKind(kind)) {
		const section = sectionForLegacyTab(kind, tab) ?? "";
		redirect(
			serviceUrl({ projectId, environmentId, kind, id }, section || undefined),
		);
	}
	return <ServiceOverview />;
}
