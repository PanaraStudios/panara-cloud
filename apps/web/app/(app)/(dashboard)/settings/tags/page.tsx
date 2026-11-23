import { TagManager } from "@/components/dashboard/settings/tags/tag-manager";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Tags" };

export default function Page() {
	return <TagManager />;
}
