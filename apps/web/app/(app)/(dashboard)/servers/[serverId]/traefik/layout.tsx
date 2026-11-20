import { TraefikShell } from "@/components/servers/traefik-shell";

export default function Layout({ children }: { children: React.ReactNode }) {
	return <TraefikShell>{children}</TraefikShell>;
}
