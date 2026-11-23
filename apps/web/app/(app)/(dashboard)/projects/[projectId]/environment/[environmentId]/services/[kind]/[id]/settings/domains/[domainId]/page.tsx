import type { Metadata } from "next";
import { SettingsSubPage } from "@/components/service-settings/sub-page";

export const metadata: Metadata = { title: "Settings" };

export default async function Page({
	params,
}: {
	params: Promise<{ domainId: string }>;
}) {
	const { domainId } = await params;
	return <SettingsSubPage list="domains" itemId={domainId} />;
}
