import { HandleDnsProvider } from "@/components/dashboard/settings/dns/handle-dns-provider";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit DNS provider" };

export default function Page() {
	const { dnsProviderId } = useParams<{ dnsProviderId: string }>();
	return <HandleDnsProvider asPage dnsProviderId={dnsProviderId} />;
}
