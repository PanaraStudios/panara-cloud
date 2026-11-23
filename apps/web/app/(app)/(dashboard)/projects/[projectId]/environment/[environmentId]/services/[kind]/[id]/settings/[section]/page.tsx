import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
	isServiceKind,
	movedSettingsSection,
	serviceUrl,
} from "@/lib/navigation";

export const metadata: Metadata = { title: "Settings" };

// A link to one section: the layout renders the Settings page with it open.
export default async function Page({
	params,
}: {
	params: Promise<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
		section: string;
	}>;
}) {
	const { projectId, environmentId, kind, id, section } = await params;
	// Source, Build type and the compose file moved to the Source tab.
	const moved = isServiceKind(kind)
		? movedSettingsSection(kind, section)
		: undefined;
	if (moved && isServiceKind(kind)) {
		redirect(serviceUrl({ projectId, environmentId, kind, id }, moved));
	}
	return null;
}
