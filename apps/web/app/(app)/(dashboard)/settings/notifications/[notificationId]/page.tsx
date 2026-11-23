import type { Metadata } from "next";
import { HandleNotifications } from "@/components/dashboard/settings/notifications/handle-notifications";

export const metadata: Metadata = { title: "Notification channel" };

export default async function Page({
	params,
}: {
	params: Promise<{ notificationId: string }>;
}) {
	const { notificationId } = await params;
	return <HandleNotifications asPage notificationId={notificationId} />;
}
