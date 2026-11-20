import type { Metadata } from "next";
import { HandleCertificate } from "@/components/dashboard/settings/certificates/handle-certificate";

export const metadata: Metadata = { title: "Edit certificate" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleCertificate asPage certificateId={id} />;
}
