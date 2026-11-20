import type { Metadata } from "next";
import { HandleCertificate } from "@/components/dashboard/settings/certificates/handle-certificate";

export const metadata: Metadata = { title: "Add certificate" };

export default function Page() {
	return <HandleCertificate asPage />;
}
