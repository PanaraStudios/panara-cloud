import type { Metadata } from "next";
import { HandleDnsProvider } from "@/components/dashboard/settings/dns/handle-dns-provider";

export const metadata: Metadata = { title: "Connect DNS provider" };

export default function Page() {
	return <HandleDnsProvider asPage />;
}
