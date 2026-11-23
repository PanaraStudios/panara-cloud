import type { Metadata } from "next";
import { ShowDnsZones } from "@/components/dashboard/settings/dns/show-dns-zones";

export const metadata: Metadata = { title: "DNS Providers" };

export default async function Page({
	params,
}: {
	params: Promise<{ dnsProviderId: string }>;
}) {
	const { dnsProviderId } = await params;
	return <ShowDnsZones dnsProviderId={dnsProviderId} />;
}
