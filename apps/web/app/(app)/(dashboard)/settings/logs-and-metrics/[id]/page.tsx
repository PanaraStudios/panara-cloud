import { HandleTelemetryProvider } from "@/components/dashboard/settings/logs-and-metrics/handle-telemetry-provider";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit destination" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleTelemetryProvider asPage telemetryProviderId={id} />;
}
