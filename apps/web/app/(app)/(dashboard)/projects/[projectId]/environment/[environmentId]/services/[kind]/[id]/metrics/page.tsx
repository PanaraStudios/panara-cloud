import { ServiceMetrics } from "@/components/service/metrics";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Metrics" };

export default function Page() {
	return <ServiceMetrics />;
}
