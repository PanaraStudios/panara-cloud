import type { Metadata } from "next";
import { ServerNetworksView } from "@/components/servers/networks-page";

export const metadata: Metadata = { title: "Networks" };

export default function Page() {
	return <ServerNetworksView />;
}
