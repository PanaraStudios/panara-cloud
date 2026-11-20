import type { Metadata } from "next";
import { ServerVolumesView } from "@/components/servers/volumes-page";

export const metadata: Metadata = { title: "Volumes" };

export default function Page() {
	return <ServerVolumesView />;
}
