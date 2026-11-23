import { ProjectRedirect } from "@/components/project-pages/project-redirect";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Project" };

export default function Page() {
	return <ProjectRedirect />;
}
