import { ServiceLogsPage } from "@/components/service/compose-logs";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Logs" };

export default function Page() {
	return <ServiceLogsPage />;
}
