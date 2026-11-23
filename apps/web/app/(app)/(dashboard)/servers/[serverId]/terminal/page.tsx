import { ServerHostTerminalPage } from "@/components/servers/terminal-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Terminal" };

export default function Page() {
	return <ServerHostTerminalPage />;
}
