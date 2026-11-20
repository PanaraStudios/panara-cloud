import { redirect } from "next/navigation";
import { type SearchParams, serverIdFrom } from "@/lib/redirects/old-routes";

export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	const server = await serverIdFrom(searchParams);
	redirect(
		server === "local"
			? "/activity/schedules"
			: `/activity/schedules?serverId=${server}`,
	);
}
