import type { Metadata } from "next";
import { ServerClusterPage } from "@/components/servers/cluster-page";

export const metadata: Metadata = { title: "Cluster" };

export default function Page() {
	return <ServerClusterPage />;
}
