import type { Metadata } from "next";
import { RequestsView } from "@/components/activity/requests-view";

export const metadata: Metadata = { title: "Requests" };

export default function Page() {
	return <RequestsView />;
}
