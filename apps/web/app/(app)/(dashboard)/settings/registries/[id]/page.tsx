import type { Metadata } from "next";
import { HandleRegistry } from "@/components/dashboard/settings/cluster/registry/handle-registry";

export const metadata: Metadata = { title: "Edit registry" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleRegistry asPage registryId={id} />;
}
