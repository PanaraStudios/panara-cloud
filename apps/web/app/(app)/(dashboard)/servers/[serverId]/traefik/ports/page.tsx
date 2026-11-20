import type { Metadata } from "next";
import { TraefikPortsPage } from "@/components/servers/traefik-ports";

export const metadata: Metadata = { title: "Traefik ports and environment" };

export default function Page() {
	return <TraefikPortsPage />;
}
