import { serverIdFrom } from "@/lib/redirects/old-routes";
import { redirect, useSearchParams } from "@/lib/router";

export default function Page() {
	const searchParams = useSearchParams();
	const server = serverIdFrom(searchParams);
	redirect(
		server === "local"
			? "/activity/schedules"
			: `/activity/schedules?serverId=${server}`,
	);
}
