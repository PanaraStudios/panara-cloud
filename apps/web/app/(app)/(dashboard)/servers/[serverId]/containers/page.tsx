import type { Metadata } from "next";
import { ServerContainersList } from "@/components/servers/containers-list";

export const metadata: Metadata = { title: "Containers" };

export default function Page() {
	return <ServerContainersList />;
}
