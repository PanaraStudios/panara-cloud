import type { Metadata } from "next";
import { ServersList } from "@/components/servers/servers-list";

export const metadata: Metadata = { title: "Servers" };

export default function Page() {
	return <ServersList />;
}
