import type { Metadata } from "next";
import { HandleNotifications } from "@/components/dashboard/settings/notifications/handle-notifications";

export const metadata: Metadata = { title: "Add channel" };

export default function Page() {
	return <HandleNotifications asPage />;
}
