import { DeploymentDetail } from "@/components/service/deployment-detail";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Deployment" };

export default function Page() {
	return <DeploymentDetail />;
}
