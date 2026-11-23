import { ServiceWorkspace } from "@/components/service/service-workspace";
import { isServiceKind } from "@/lib/navigation";
import { notFound, useParams } from "@/lib/router";

export default function Layout({ children }: { children: React.ReactNode }) {
	const { kind } = useParams<{ kind: string }>();
	if (!isServiceKind(kind)) notFound();
	return <ServiceWorkspace>{children}</ServiceWorkspace>;
}
