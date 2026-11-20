import type { Metadata } from "next";
import { ServerSwarmPage } from "@/components/servers/swarm-page";

export const metadata: Metadata = { title: "Swarm" };

export default function Page() {
	return <ServerSwarmPage />;
}
