import type { Metadata } from "next";
import { HandleDestinations } from "@/components/dashboard/settings/destination/handle-destinations";

export const metadata: Metadata = { title: "Edit destination" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleDestinations asPage destinationId={id} />;
}
