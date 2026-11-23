import type { Metadata } from "next";
import { NewSandboxPage } from "@/components/servers/sandboxes-page";

export const metadata: Metadata = { title: "New sandbox" };

export default function Page() {
	return <NewSandboxPage />;
}
