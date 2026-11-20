import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectProviderPage } from "@/components/dashboard/settings/git/connect-provider-page";

export const metadata: Metadata = { title: "Connect provider" };

export default function Page() {
	return (
		<Suspense>
			<ConnectProviderPage />
		</Suspense>
	);
}
