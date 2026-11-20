import type { Metadata } from "next";
import { ServiceDeployments } from "@/components/service/deployments";

export const metadata: Metadata = { title: "Deployments" };

export default function Page() {
	return <ServiceDeployments />;
}
