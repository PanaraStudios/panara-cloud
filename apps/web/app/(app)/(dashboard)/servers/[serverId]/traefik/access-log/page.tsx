import { TraefikAccessLogPage } from "@/components/servers/traefik-access-log";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Traefik access log" };

export default function Page() {
	return <TraefikAccessLogPage />;
}
