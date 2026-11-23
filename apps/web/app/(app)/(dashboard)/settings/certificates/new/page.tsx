import { HandleCertificate } from "@/components/dashboard/settings/certificates/handle-certificate";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add certificate" };

export default function Page() {
	return <HandleCertificate asPage />;
}
