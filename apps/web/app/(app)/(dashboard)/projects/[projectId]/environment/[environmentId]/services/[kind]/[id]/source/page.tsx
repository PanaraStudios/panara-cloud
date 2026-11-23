import { ServiceSourcePage } from "@/components/service-source/source-page";
import { hasSourceTab, isServiceKind, serviceUrl } from "@/lib/navigation";
import type { Metadata } from "@/lib/router";
import { redirect, useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Source" };

export default function Page() {
	const { projectId, environmentId, kind, id } = useParams<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>();
	// A database has no source: its tab bar has no Source, and a link that
	// kept the section while switching services lands on its Overview.
	if (isServiceKind(kind) && !hasSourceTab(kind)) {
		redirect(serviceUrl({ projectId, environmentId, kind, id }));
	}
	return <ServiceSourcePage />;
}
