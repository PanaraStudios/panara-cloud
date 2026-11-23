import { notFound } from "next/navigation";
import { ServiceWorkspace } from "@/components/service/service-workspace";
import { isServiceKind } from "@/lib/navigation";

export default async function Layout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ kind: string }>;
}) {
	const { kind } = await params;
	if (!isServiceKind(kind)) notFound();
	return <ServiceWorkspace>{children}</ServiceWorkspace>;
}
