import type { Metadata } from "next";
import { SettingsHub } from "@/components/settings/settings-area";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
	return <SettingsHub />;
}
