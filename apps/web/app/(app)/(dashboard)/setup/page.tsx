import type { Metadata } from "next";
import { PanelSetup } from "@/components/dashboard/setup/panel-setup";

export const metadata: Metadata = { title: "Set up your panel" };

export default function Page() {
	return <PanelSetup />;
}
