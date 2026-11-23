import type { Metadata } from "next";
import { PanelDomainSettings } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Panel domain" };

export default function Page() {
	return <PanelDomainSettings />;
}
