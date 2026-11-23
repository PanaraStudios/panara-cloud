import { ShowServers } from "@/components/dashboard/settings/logs-and-metrics/show-servers";
import { ShowTelemetryProviders } from "@/components/dashboard/settings/logs-and-metrics/show-telemetry-providers";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Logs & metrics" };

export default function Page() {
	return (
		<div className="flex w-full flex-col gap-8">
			<ShowTelemetryProviders />
			<ShowServers />
		</div>
	);
}
