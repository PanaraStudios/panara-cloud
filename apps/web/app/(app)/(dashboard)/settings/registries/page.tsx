import type { Metadata } from "next";
import { ShowRegistry } from "@/components/dashboard/settings/cluster/registry/show-registry";

export const metadata: Metadata = { title: "Registries" };

export default function Page() {
	return <ShowRegistry />;
}
