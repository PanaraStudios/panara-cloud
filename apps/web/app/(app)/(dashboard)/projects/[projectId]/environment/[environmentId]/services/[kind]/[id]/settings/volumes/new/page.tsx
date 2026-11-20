import type { Metadata } from "next";
import { Suspense } from "react";
import { MountEditorPage } from "@/components/service-settings/mount-editor";

export const metadata: Metadata = { title: "Add mount" };

export default function Page() {
	return (
		<Suspense>
			<MountEditorPage />
		</Suspense>
	);
}
