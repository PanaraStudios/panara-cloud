import { ShowRegistry } from "@/components/dashboard/settings/cluster/registry/show-registry";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Registries" };

export default function Page() {
	return <ShowRegistry />;
}
