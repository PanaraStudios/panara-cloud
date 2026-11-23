import { TraefikConfigFiles } from "@/components/servers/traefik-config";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Traefik" };

export default function Page() {
	return <TraefikConfigFiles />;
}
