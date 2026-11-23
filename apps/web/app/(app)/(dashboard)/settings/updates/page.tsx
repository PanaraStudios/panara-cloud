import { PanelUpdatesSettings } from "@/components/settings/general-settings";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Updates" };

export default function Page() {
	return <PanelUpdatesSettings />;
}
