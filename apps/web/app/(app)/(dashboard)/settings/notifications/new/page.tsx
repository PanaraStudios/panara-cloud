import { HandleNotifications } from "@/components/dashboard/settings/notifications/handle-notifications";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add channel" };

export default function Page() {
	return <HandleNotifications asPage />;
}
