import { redirect, useParams } from "@/lib/router";

export default function Page() {
	const { serverId, nodeId } = useParams<{
		serverId: string;
		nodeId: string;
	}>();
	redirect(`/servers/${serverId}/cluster/${nodeId}`);
}
