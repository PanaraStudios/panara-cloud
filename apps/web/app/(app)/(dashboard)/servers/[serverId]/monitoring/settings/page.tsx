import { MonitoringSettingsPage } from "@/components/servers/monitoring-setup";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Monitoring settings" };

export default function Page() {
	return <MonitoringSettingsPage />;
}
