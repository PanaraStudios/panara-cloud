import { AddNodePage } from "@/components/servers/cluster-add-node";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add node" };

export default function Page() {
	return <AddNodePage />;
}
