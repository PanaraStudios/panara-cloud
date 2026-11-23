import { ServiceOverview } from "@/components/service/overview";
import {
	isServiceKind,
	sectionForLegacyTab,
	serviceUrl,
} from "@/lib/navigation";
import {
	type Metadata,
	redirect,
	useParams,
	useSearchParams,
} from "@/lib/router";

export const metadata: Metadata = { title: "Service" };

export default function Page() {
	const { projectId, environmentId, kind, id } = useParams<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>();
	const tab = useSearchParams().get("tab");
	// Older links point at sections with `?tab=`; send them to the section's path.
	if (tab !== null && isServiceKind(kind)) {
		const section = sectionForLegacyTab(kind, tab) ?? "";
		redirect(
			serviceUrl({ projectId, environmentId, kind, id }, section || undefined),
		);
	}
	return <ServiceOverview />;
}
