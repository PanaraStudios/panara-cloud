import { ServersList } from "@/components/servers/servers-list";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Servers" };

export default function Page() {
	return <ServersList />;
}
