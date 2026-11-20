import type { Metadata } from "next";
import { ProjectVariables } from "@/components/project-pages/project-variables";

export const metadata: Metadata = { title: "Variables" };

export default function Page() {
	return <ProjectVariables />;
}
