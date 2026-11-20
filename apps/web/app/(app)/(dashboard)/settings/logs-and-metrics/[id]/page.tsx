import type { Metadata } from "next";
import { HandleTelemetryProvider } from "@/components/dashboard/settings/logs-and-metrics/handle-telemetry-provider";

export const metadata: Metadata = { title: "Edit destination" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleTelemetryProvider asPage telemetryProviderId={id} />;
}
