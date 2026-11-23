import { HandleDnsProvider } from "@/components/dashboard/settings/dns/handle-dns-provider";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Connect DNS provider" };

export default function Page() {
	return <HandleDnsProvider asPage />;
}
