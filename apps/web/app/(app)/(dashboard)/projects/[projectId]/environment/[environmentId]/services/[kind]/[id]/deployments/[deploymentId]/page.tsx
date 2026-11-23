import type { Metadata } from "next";
import { DeploymentDetail } from "@/components/service/deployment-detail";

export const metadata: Metadata = { title: "Deployment" };

export default function Page() {
	return <DeploymentDetail />;
}
