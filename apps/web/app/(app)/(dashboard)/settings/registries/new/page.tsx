import { HandleRegistry } from "@/components/dashboard/settings/cluster/registry/handle-registry";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add registry" };

export default function Page() {
	return <HandleRegistry asPage />;
}
