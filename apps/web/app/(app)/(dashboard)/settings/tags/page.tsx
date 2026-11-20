import type { Metadata } from "next";
import { TagManager } from "@/components/dashboard/settings/tags/tag-manager";

export const metadata: Metadata = { title: "Tags" };

export default function Page() {
	return <TagManager />;
}
