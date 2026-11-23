import { ContainerShell } from "@/components/servers/container-pages";

export default async function Layout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ containerId: string }>;
}) {
	const { containerId } = await params;
	return (
		<ContainerShell containerId={decodeURIComponent(containerId)}>
			{children}
		</ContainerShell>
	);
}
