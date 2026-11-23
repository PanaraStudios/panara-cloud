import { ServerMonitoringPage } from "@/components/servers/monitoring-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Monitoring" };

export default function Page() {
	return <ServerMonitoringPage />;
}
