import type { Metadata } from "next";
import { DeploymentsView } from "@/components/activity/deployments-view";

export const metadata: Metadata = { title: "Deployments" };

export default function Page() {
	return <DeploymentsView />;
}
