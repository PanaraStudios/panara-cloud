import type { Metadata } from "next";
import { PanelUpdatesSettings } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Updates" };

export default function Page() {
	return <PanelUpdatesSettings />;
}
