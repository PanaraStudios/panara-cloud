import type { Metadata } from "next";
import { ShowCertificates } from "@/components/dashboard/settings/certificates/show-certificates";

export const metadata: Metadata = { title: "Certificates" };

export default function Page() {
	return <ShowCertificates />;
}
