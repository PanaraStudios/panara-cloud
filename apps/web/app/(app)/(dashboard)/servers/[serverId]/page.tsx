import type { Metadata } from "next";
import { ServerOverview } from "@/components/servers/server-overview";

export const metadata: Metadata = { title: "Server" };

export default function Page() {
	return <ServerOverview />;
}
