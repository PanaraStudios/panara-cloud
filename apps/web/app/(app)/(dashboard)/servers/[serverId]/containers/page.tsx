import { ServerContainersList } from "@/components/servers/containers-list";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Containers" };

export default function Page() {
	return <ServerContainersList />;
}
