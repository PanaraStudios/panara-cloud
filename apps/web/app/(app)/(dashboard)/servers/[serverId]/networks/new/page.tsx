import type { Metadata } from "next";
import { NewNetworkPage } from "@/components/servers/networks-page";

export const metadata: Metadata = { title: "Create network" };

export default function Page() {
	return <NewNetworkPage />;
}
