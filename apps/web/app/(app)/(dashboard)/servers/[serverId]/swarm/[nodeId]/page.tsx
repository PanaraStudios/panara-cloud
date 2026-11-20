import type { Metadata } from "next";
import { SwarmNodePage } from "@/components/servers/swarm-page";

export const metadata: Metadata = { title: "Swarm node" };

export default async function Page({
	params,
}: {
	params: Promise<{ nodeId: string }>;
}) {
	const { nodeId } = await params;
	return <SwarmNodePage nodeId={decodeURIComponent(nodeId)} />;
}
