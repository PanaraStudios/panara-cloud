import type { Metadata } from "next";
import { HandleDnsProvider } from "@/components/dashboard/settings/dns/handle-dns-provider";

export const metadata: Metadata = { title: "Edit DNS provider" };

export default async function Page({
	params,
}: {
	params: Promise<{ dnsProviderId: string }>;
}) {
	const { dnsProviderId } = await params;
	return <HandleDnsProvider asPage dnsProviderId={dnsProviderId} />;
}
