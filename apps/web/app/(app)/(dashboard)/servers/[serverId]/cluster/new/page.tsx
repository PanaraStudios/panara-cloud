import type { Metadata } from "next";
import { AddNodePage } from "@/components/servers/cluster-add-node";

export const metadata: Metadata = { title: "Add node" };

export default function Page() {
	return <AddNodePage />;
}
