import { TraefikPortsPage } from "@/components/servers/traefik-ports";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Traefik ports and environment" };

export default function Page() {
	return <TraefikPortsPage />;
}
