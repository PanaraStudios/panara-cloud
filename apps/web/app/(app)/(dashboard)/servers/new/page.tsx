import type { Metadata } from "next";
import { NewServer } from "@/components/servers/new-server";

export const metadata: Metadata = { title: "Add server" };

export default function Page() {
	return <NewServer />;
}
