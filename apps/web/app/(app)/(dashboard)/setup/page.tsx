import { PanelSetup } from "@/components/dashboard/setup/panel-setup";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Set up your panel" };

export default function Page() {
	return <PanelSetup />;
}
