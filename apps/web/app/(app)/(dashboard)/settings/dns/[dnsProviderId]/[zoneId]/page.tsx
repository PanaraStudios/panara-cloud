import type { Metadata } from "next";
import { ShowDnsRecords } from "@/components/dashboard/settings/dns/show-dns-records";

export const metadata: Metadata = { title: "DNS Providers" };

export default async function Page({
	params,
}: {
	params: Promise<{ dnsProviderId: string; zoneId: string }>;
}) {
	const { dnsProviderId, zoneId } = await params;
	return (
		<ShowDnsRecords
			dnsProviderId={dnsProviderId}
			zoneId={decodeURIComponent(zoneId)}
		/>
	);
}
