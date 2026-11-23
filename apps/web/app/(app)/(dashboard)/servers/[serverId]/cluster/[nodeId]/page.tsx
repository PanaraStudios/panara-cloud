import type { Metadata } from "next";
import { ClusterNodePage } from "@/components/servers/cluster-page";

export const metadata: Metadata = { title: "Cluster node" };

export default async function Page({
	params,
}: {
	params: Promise<{ nodeId: string }>;
}) {
	const { nodeId } = await params;
	return <ClusterNodePage nodeId={decodeURIComponent(nodeId)} />;
}
