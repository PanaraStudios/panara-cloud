import type { Metadata } from "next";
import { ServerImagesList } from "@/components/servers/images-list";

export const metadata: Metadata = { title: "Images" };

export default function Page() {
	return <ServerImagesList />;
}
