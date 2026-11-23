import { HandleCertificate } from "@/components/dashboard/settings/certificates/handle-certificate";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit certificate" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleCertificate asPage certificateId={id} />;
}
