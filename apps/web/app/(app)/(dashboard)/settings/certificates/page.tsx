import { ShowCertificates } from "@/components/dashboard/settings/certificates/show-certificates";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Certificates" };

export default function Page() {
	return <ShowCertificates />;
}
