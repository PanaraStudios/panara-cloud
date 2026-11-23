import { ShowDnsZones } from "@/components/dashboard/settings/dns/show-dns-zones";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "DNS Providers" };

export default function Page() {
	const { dnsProviderId } = useParams<{ dnsProviderId: string }>();
	return <ShowDnsZones dnsProviderId={dnsProviderId} />;
}
