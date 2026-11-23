import {
	isServiceKind,
	movedSettingsSection,
	serviceUrl,
} from "@/lib/navigation";
import type { Metadata } from "@/lib/router";
import { redirect, useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Settings" };

// A link to one section: the layout renders the Settings page with it open.
export default function Page() {
	const { projectId, environmentId, kind, id, section } = useParams<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
		section: string;
	}>();
	// Source, Build type and the compose file moved to the Source tab.
	const moved = isServiceKind(kind)
		? movedSettingsSection(kind, section)
		: undefined;
	if (moved && isServiceKind(kind)) {
		redirect(serviceUrl({ projectId, environmentId, kind, id }, moved));
	}
	return null;
}
