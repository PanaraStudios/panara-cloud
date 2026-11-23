import { ContainerFilesPage } from "@/components/servers/container-pages";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Container files" };

export default function Page() {
	const { containerId } = useParams<{ containerId: string }>();
	return <ContainerFilesPage containerId={decodeURIComponent(containerId)} />;
}
