import { ServiceDeployments } from "@/components/service/deployments";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Deployments" };

export default function Page() {
	return <ServiceDeployments />;
}
