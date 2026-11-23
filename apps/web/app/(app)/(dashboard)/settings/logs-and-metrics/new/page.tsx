import { HandleTelemetryProvider } from "@/components/dashboard/settings/logs-and-metrics/handle-telemetry-provider";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add destination" };

export default function Page() {
	return <HandleTelemetryProvider asPage />;
}
