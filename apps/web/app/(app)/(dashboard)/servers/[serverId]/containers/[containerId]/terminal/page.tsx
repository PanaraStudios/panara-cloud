import type { Metadata } from "next";
import { ContainerTerminalPage } from "@/components/servers/container-pages";

export const metadata: Metadata = { title: "Container terminal" };

export default async function Page({
	params,
}: {
	params: Promise<{ containerId: string }>;
}) {
	const { containerId } = await params;
	return (
		<ContainerTerminalPage containerId={decodeURIComponent(containerId)} />
	);
}
