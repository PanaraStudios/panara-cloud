import { ClusterNodePage } from "@/components/servers/cluster-page";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Cluster node" };

export default function Page() {
	const { nodeId } = useParams<{ nodeId: string }>();
	return <ClusterNodePage nodeId={decodeURIComponent(nodeId)} />;
}
