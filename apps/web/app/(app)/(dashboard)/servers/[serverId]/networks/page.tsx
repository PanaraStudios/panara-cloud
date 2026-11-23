import { ServerNetworksView } from "@/components/servers/networks-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Networks" };

export default function Page() {
	return <ServerNetworksView />;
}
