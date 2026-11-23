import { redirect } from "next/navigation";

export default async function Page({
	params,
}: {
	params: Promise<{ serverId: string; nodeId: string }>;
}) {
	const { serverId, nodeId } = await params;
	redirect(`/servers/${serverId}/cluster/${nodeId}`);
}
