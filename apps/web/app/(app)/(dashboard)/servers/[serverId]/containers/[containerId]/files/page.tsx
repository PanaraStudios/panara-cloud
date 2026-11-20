import type { Metadata } from "next";
import { ContainerFilesPage } from "@/components/servers/container-pages";

export const metadata: Metadata = { title: "Container files" };

export default async function Page({
	params,
}: {
	params: Promise<{ containerId: string }>;
}) {
	const { containerId } = await params;
	return <ContainerFilesPage containerId={decodeURIComponent(containerId)} />;
}
