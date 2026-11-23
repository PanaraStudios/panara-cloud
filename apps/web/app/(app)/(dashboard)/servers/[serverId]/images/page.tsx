import { ServerImagesList } from "@/components/servers/images-list";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Images" };

export default function Page() {
	return <ServerImagesList />;
}
