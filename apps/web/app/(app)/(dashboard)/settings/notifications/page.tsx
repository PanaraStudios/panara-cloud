import type { Metadata } from "next";
import { NotificationsPage } from "@/components/dashboard/settings/notifications/notifications-page";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
	return <NotificationsPage />;
}
