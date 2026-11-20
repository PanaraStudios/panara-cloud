import type { Metadata } from "next";
import { Suspense } from "react";
import { ServerAppLogsPage } from "@/components/servers/server-sections";

export const metadata: Metadata = { title: "Logs" };

export default function Page() {
	return (
		<Suspense>
			<ServerAppLogsPage />
		</Suspense>
	);
}
