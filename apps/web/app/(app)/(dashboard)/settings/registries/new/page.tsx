import type { Metadata } from "next";
import { HandleRegistry } from "@/components/dashboard/settings/cluster/registry/handle-registry";

export const metadata: Metadata = { title: "Add registry" };

export default function Page() {
	return <HandleRegistry asPage />;
}
