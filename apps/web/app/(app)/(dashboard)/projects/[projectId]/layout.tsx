import { ProjectWorkspace } from "@/components/project-pages/project-workspace";

export default function Layout({ children }: { children: React.ReactNode }) {
	return <ProjectWorkspace>{children}</ProjectWorkspace>;
}
