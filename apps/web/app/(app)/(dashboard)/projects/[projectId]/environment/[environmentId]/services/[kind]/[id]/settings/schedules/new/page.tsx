import { SettingsSubPage } from "@/components/service-settings/sub-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
	return <SettingsSubPage list="schedules" />;
}
