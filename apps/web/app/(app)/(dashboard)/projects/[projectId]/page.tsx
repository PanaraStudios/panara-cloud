import type { Metadata } from "next";
import { ProjectRedirect } from "@/components/project-pages/project-redirect";

export const metadata: Metadata = { title: "Project" };

export default function Page() {
	return <ProjectRedirect />;
}
