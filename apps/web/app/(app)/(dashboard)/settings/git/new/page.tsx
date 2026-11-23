import { Suspense } from "react";
import { ConnectProviderPage } from "@/components/dashboard/settings/git/connect-provider-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Connect provider" };

export default function Page() {
	return (
		<Suspense>
			<ConnectProviderPage />
		</Suspense>
	);
}
