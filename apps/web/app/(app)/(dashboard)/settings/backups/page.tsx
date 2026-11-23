import type { Metadata } from "next";
import { PanelBackupsSettings } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Panel backups" };

export default function Page() {
	return <PanelBackupsSettings />;
}
