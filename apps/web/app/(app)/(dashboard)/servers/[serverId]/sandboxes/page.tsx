import { ServerSandboxesPage } from "@/components/servers/sandboxes-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Sandboxes" };

export default function Page() {
	return <ServerSandboxesPage />;
}
