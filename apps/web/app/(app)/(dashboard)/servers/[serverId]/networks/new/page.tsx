import { NewNetworkPage } from "@/components/servers/networks-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Create network" };

export default function Page() {
	return <NewNetworkPage />;
}
