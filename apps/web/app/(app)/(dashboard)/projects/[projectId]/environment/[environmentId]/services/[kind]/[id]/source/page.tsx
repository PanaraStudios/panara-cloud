import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ServiceSourcePage } from "@/components/service-source/source-page";
import { hasSourceTab, isServiceKind, serviceUrl } from "@/lib/navigation";

export const metadata: Metadata = { title: "Source" };

export default async function Page({
	params,
}: {
	params: Promise<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>;
}) {
	const { projectId, environmentId, kind, id } = await params;
	// A database has no source: its tab bar has no Source, and a link that
	// kept the section while switching services lands on its Overview.
	if (isServiceKind(kind) && !hasSourceTab(kind)) {
		redirect(serviceUrl({ projectId, environmentId, kind, id }));
	}
	return <ServiceSourcePage />;
}
