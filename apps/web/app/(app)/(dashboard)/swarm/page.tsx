import { serverIdFrom } from "@/lib/redirects/old-routes";
import { redirect, useSearchParams } from "@/lib/router";

export default function Page() {
	const searchParams = useSearchParams();
	redirect(`/servers/${serverIdFrom(searchParams)}/cluster`);
}
