import { RequestsView } from "@/components/activity/requests-view";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Requests" };

export default function Page() {
	return <RequestsView />;
}
