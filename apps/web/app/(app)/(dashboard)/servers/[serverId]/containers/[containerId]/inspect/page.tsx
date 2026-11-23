import type { Metadata } from "next";
import { ContainerInspectPage } from "@/components/servers/container-pages";

export const metadata: Metadata = { title: "Container inspect" };

export default async function Page({
	params,
}: {
	params: Promise<{ containerId: string }>;
}) {
	const { containerId } = await params;
	return <ContainerInspectPage containerId={decodeURIComponent(containerId)} />;
}
