import { ProjectVariables } from "@/components/project-pages/project-variables";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Variables" };

export default function Page() {
	return <ProjectVariables />;
}
