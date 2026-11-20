import type { Metadata } from "next";
import { ImageInspectPage } from "@/components/servers/images-inspect";

export const metadata: Metadata = { title: "Image" };

export default async function Page({
	params,
}: {
	params: Promise<{ imageId: string }>;
}) {
	const { imageId } = await params;
	return <ImageInspectPage imageId={decodeURIComponent(imageId)} />;
}
