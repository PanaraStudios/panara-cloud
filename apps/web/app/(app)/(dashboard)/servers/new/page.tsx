import { NewServer } from "@/components/servers/new-server";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add server" };

export default function Page() {
	return <NewServer />;
}
