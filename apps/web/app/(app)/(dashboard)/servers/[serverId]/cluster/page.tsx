import { ServerClusterPage } from "@/components/servers/cluster-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Cluster" };

export default function Page() {
	return <ServerClusterPage />;
}
