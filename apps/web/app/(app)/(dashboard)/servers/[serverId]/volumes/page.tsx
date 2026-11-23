import { ServerVolumesView } from "@/components/servers/volumes-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Volumes" };

export default function Page() {
	return <ServerVolumesView />;
}
