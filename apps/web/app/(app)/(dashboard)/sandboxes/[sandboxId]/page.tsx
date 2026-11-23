import { redirect } from "next/navigation";

export default async function Page({
	params,
}: {
	params: Promise<{ sandboxId: string }>;
}) {
	const { sandboxId } = await params;
	redirect(`/servers/local/sandboxes/${encodeURIComponent(sandboxId)}`);
}
