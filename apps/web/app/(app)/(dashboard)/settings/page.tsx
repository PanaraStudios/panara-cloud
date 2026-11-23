import { SettingsHub } from "@/components/settings/settings-area";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
	return <SettingsHub />;
}
