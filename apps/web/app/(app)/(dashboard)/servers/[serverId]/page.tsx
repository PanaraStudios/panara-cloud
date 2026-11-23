import { ServerOverview } from "@/components/servers/server-overview";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Server" };

export default function Page() {
	return <ServerOverview />;
}
