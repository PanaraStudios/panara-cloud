import type { Metadata } from "next";
import { HandleTelemetryProvider } from "@/components/dashboard/settings/logs-and-metrics/handle-telemetry-provider";

export const metadata: Metadata = { title: "Add destination" };

export default function Page() {
	return <HandleTelemetryProvider asPage />;
}
