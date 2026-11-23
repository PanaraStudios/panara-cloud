import type { Metadata } from "next";
import { ServerMonitoringPage } from "@/components/servers/monitoring-page";

export const metadata: Metadata = { title: "Monitoring" };

export default function Page() {
	return <ServerMonitoringPage />;
}
