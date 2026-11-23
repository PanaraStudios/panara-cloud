import { NewSandboxPage } from "@/components/servers/sandboxes-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "New sandbox" };

export default function Page() {
	return <NewSandboxPage />;
}
