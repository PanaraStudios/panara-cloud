import { ContainerShell } from "@/components/servers/container-pages";
import { useParams } from "@/lib/router";

export default function Layout({ children }: { children: React.ReactNode }) {
	const { containerId } = useParams<{ containerId: string }>();
	return (
		<ContainerShell containerId={decodeURIComponent(containerId)}>
			{children}
		</ContainerShell>
	);
}
