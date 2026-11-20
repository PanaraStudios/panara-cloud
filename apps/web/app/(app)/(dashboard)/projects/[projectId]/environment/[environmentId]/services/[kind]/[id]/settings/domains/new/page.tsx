import type { Metadata } from "next";
import { SettingsSubPage } from "@/components/service-settings/sub-page";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
	return <SettingsSubPage list="domains" />;
}
