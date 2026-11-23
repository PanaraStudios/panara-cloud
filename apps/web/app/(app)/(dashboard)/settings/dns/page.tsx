import type { Metadata } from "next";
import { ShowDnsProviders } from "@/components/dashboard/settings/dns/show-dns-providers";

export const metadata: Metadata = { title: "DNS Providers" };

export default function Page() {
	return <ShowDnsProviders />;
}
