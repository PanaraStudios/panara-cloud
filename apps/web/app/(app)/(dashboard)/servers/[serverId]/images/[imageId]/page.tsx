import { ImageInspectPage } from "@/components/servers/images-inspect";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Image" };

export default function Page() {
	const { imageId } = useParams<{ imageId: string }>();
	return <ImageInspectPage imageId={decodeURIComponent(imageId)} />;
}
