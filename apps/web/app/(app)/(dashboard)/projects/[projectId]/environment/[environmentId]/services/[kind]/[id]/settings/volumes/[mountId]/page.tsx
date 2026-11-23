import { Suspense } from "react";
import { MountEditorPage } from "@/components/service-settings/mount-editor";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit mount" };

export default function Page() {
	const { mountId } = useParams<{ mountId: string }>();
	return (
		<Suspense>
			<MountEditorPage mountId={mountId} />
		</Suspense>
	);
}
