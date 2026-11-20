import type { Metadata } from "next";
import { ServiceMetrics } from "@/components/service/metrics";

export const metadata: Metadata = { title: "Metrics" };

export default function Page() {
	return <ServiceMetrics />;
}
