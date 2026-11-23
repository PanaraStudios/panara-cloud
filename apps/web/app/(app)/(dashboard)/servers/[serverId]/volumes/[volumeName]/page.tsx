import { VolumeBrowsePage } from "@/components/servers/volumes-browse";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Volume files" };

export default function Page() {
	const { volumeName } = useParams<{ volumeName: string }>();
	return <VolumeBrowsePage volumeName={decodeURIComponent(volumeName)} />;
}
