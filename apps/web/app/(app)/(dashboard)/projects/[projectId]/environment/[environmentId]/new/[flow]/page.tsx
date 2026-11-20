import type { Metadata } from "next";
import { NewServicePage } from "@/components/project-pages/new-service-page";

export const metadata: Metadata = { title: "New service" };

export default async function Page({
	params,
}: {
	params: Promise<{ flow: string }>;
}) {
	const { flow } = await params;
	return <NewServicePage flow={flow} />;
}
