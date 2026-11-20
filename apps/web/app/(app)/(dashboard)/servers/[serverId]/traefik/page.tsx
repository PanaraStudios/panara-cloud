import type { Metadata } from "next";
import { TraefikConfigFiles } from "@/components/servers/traefik-config";

export const metadata: Metadata = { title: "Traefik" };

export default function Page() {
	return <TraefikConfigFiles />;
}
