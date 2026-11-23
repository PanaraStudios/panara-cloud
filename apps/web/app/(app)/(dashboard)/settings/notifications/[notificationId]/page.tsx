import { HandleNotifications } from "@/components/dashboard/settings/notifications/handle-notifications";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Notification channel" };

export default function Page() {
	const { notificationId } = useParams<{ notificationId: string }>();
	return <HandleNotifications asPage notificationId={notificationId} />;
}
