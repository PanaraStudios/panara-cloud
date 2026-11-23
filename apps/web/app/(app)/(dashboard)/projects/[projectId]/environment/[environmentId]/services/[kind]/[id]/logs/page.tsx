import type { Metadata } from "next";
import { ServiceLogsPage } from "@/components/service/compose-logs";

export const metadata: Metadata = { title: "Logs" };

export default function Page() {
	return <ServiceLogsPage />;
}
