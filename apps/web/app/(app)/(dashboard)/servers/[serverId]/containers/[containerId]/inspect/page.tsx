import { ContainerInspectPage } from "@/components/servers/container-pages";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Container inspect" };

export default function Page() {
	const { containerId } = useParams<{ containerId: string }>();
	return <ContainerInspectPage containerId={decodeURIComponent(containerId)} />;
}
