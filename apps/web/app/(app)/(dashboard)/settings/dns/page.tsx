import { ShowDnsProviders } from "@/components/dashboard/settings/dns/show-dns-providers";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "DNS Providers" };

export default function Page() {
	return <ShowDnsProviders />;
}
