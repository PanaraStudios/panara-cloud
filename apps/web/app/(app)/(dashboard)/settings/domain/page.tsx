import { PanelDomainSettings } from "@/components/settings/general-settings";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Panel domain" };

export default function Page() {
	return <PanelDomainSettings />;
}
