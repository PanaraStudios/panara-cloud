import { ShowDnsRecords } from "@/components/dashboard/settings/dns/show-dns-records";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "DNS Providers" };

export default function Page() {
	const { dnsProviderId, zoneId } = useParams<{
		dnsProviderId: string;
		zoneId: string;
	}>();
	return (
		<ShowDnsRecords
			dnsProviderId={dnsProviderId}
			zoneId={decodeURIComponent(zoneId)}
		/>
	);
}
