import { ProjectSettings } from "@/components/project-pages/project-settings";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Project settings" };

export default function Page() {
	return <ProjectSettings />;
}
