import { NotificationsPage } from "@/components/dashboard/settings/notifications/notifications-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
	return <NotificationsPage />;
}
