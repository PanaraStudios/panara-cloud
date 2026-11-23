import { Suspense } from "react";
import { ServerAppLogsPage } from "@/components/servers/server-sections";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Logs" };

export default function Page() {
	return (
		<Suspense>
			<ServerAppLogsPage />
		</Suspense>
	);
}
