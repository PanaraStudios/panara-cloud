import type { Metadata } from "next";
import { MonitoringSettingsPage } from "@/components/servers/monitoring-setup";

export const metadata: Metadata = { title: "Monitoring settings" };

export default function Page() {
	return <MonitoringSettingsPage />;
}
