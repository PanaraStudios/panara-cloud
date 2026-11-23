import type { Metadata } from "next";
import { ServerSandboxesPage } from "@/components/servers/sandboxes-page";

export const metadata: Metadata = { title: "Sandboxes" };

export default function Page() {
	return <ServerSandboxesPage />;
}
