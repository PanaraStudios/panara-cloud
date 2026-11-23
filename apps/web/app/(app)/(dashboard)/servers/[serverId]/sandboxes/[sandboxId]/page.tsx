import { SandboxView } from "@/components/servers/sandbox-view";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Sandbox" };

export default function Page() {
	const { serverId, sandboxId } = useParams<{
		serverId: string;
		sandboxId: string;
	}>();
	return (
		<SandboxView
			sandboxId={sandboxId}
			listHref={`/servers/${serverId}/sandboxes`}
		/>
	);
}
