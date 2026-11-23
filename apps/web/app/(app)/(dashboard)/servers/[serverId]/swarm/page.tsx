import { redirect, useParams } from "@/lib/router";

// The tab was called Swarm; its links keep working.
export default function Page() {
	const { serverId } = useParams<{ serverId: string }>();
	redirect(`/servers/${serverId}/cluster`);
}
