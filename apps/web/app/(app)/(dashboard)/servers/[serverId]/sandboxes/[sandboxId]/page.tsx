import type { Metadata } from "next";
import { SandboxView } from "@/components/servers/sandbox-view";

export const metadata: Metadata = { title: "Sandbox" };

export default async function Page({
	params,
}: {
	params: Promise<{ serverId: string; sandboxId: string }>;
}) {
	const { serverId, sandboxId } = await params;
	return (
		<SandboxView
			sandboxId={sandboxId}
			listHref={`/servers/${serverId}/sandboxes`}
		/>
	);
}
