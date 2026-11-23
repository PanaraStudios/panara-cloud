import { PanelBackupsSettings } from "@/components/settings/general-settings";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Panel backups" };

export default function Page() {
	return <PanelBackupsSettings />;
}
