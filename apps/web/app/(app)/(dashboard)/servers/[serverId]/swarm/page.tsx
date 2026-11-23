import { redirect } from "next/navigation";

// The tab was called Swarm; its links keep working.
export default async function Page({
	params,
}: {
	params: Promise<{ serverId: string }>;
}) {
	const { serverId } = await params;
	redirect(`/servers/${serverId}/cluster`);
}
