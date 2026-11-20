import type { Metadata } from "next";
import { Suspense } from "react";
import { MountEditorPage } from "@/components/service-settings/mount-editor";

export const metadata: Metadata = { title: "Edit mount" };

export default async function Page({
	params,
}: {
	params: Promise<{ mountId: string }>;
}) {
	const { mountId } = await params;
	return (
		<Suspense>
			<MountEditorPage mountId={mountId} />
		</Suspense>
	);
}
