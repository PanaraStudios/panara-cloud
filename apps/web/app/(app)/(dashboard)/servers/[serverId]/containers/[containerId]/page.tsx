import type { Metadata } from "next";
import { ContainerLogsPage } from "@/components/servers/container-pages";

export const metadata: Metadata = { title: "Container logs" };

export default async function Page({
	params,
}: {
	params: Promise<{ containerId: string }>;
}) {
	const { containerId } = await params;
	return <ContainerLogsPage containerId={decodeURIComponent(containerId)} />;
}
