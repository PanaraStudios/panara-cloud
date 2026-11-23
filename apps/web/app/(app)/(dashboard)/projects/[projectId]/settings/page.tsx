import type { Metadata } from "next";
import { ProjectSettings } from "@/components/project-pages/project-settings";

export const metadata: Metadata = { title: "Project settings" };

export default function Page() {
	return <ProjectSettings />;
}
