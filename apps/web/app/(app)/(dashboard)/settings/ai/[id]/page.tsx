import type { Metadata } from "next";
import { HandleAi } from "@/components/dashboard/settings/handle-ai";

export const metadata: Metadata = { title: "Edit AI provider" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleAi asPage aiId={id} />;
}
