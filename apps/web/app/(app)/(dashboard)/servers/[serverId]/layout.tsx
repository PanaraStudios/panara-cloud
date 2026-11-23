import { ServerWorkspace } from "@/components/servers/server-workspace";

export default function Layout({ children }: { children: React.ReactNode }) {
	return <ServerWorkspace>{children}</ServerWorkspace>;
}
