import type { Metadata } from "next";
import { TraefikAccessLogPage } from "@/components/servers/traefik-access-log";

export const metadata: Metadata = { title: "Traefik access log" };

export default function Page() {
	return <TraefikAccessLogPage />;
}
