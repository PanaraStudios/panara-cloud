import type { Metadata } from "next";
import { ServerHostTerminalPage } from "@/components/servers/terminal-page";

export const metadata: Metadata = { title: "Terminal" };

export default function Page() {
	return <ServerHostTerminalPage />;
}
