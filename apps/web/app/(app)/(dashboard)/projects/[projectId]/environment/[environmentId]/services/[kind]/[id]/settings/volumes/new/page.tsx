import { Suspense } from "react";
import { MountEditorPage } from "@/components/service-settings/mount-editor";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add mount" };

export default function Page() {
	return (
		<Suspense>
			<MountEditorPage />
		</Suspense>
	);
}
