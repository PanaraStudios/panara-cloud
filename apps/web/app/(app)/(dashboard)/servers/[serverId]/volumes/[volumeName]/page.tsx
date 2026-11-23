import type { Metadata } from "next";
import { VolumeBrowsePage } from "@/components/servers/volumes-browse";

export const metadata: Metadata = { title: "Volume files" };

export default async function Page({
	params,
}: {
	params: Promise<{ volumeName: string }>;
}) {
	const { volumeName } = await params;
	return <VolumeBrowsePage volumeName={decodeURIComponent(volumeName)} />;
}
