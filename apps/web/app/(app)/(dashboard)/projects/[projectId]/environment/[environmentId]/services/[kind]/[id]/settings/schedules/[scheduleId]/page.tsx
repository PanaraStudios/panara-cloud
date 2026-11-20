import type { Metadata } from "next";
import { SettingsSubPage } from "@/components/service-settings/sub-page";

export const metadata: Metadata = { title: "Settings" };

export default async function Page({
	params,
}: {
	params: Promise<{ scheduleId: string }>;
}) {
	const { scheduleId } = await params;
	return <SettingsSubPage list="schedules" itemId={scheduleId} />;
}
