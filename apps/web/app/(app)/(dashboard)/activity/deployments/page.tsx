import { DeploymentsView } from "@/components/activity/deployments-view";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Deployments" };

export default function Page() {
	return <DeploymentsView />;
}
