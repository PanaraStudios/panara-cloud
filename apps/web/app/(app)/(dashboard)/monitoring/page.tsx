import { redirect } from "next/navigation";
import { type SearchParams, serverIdFrom } from "@/lib/redirects/old-routes";

export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	redirect(`/servers/${await serverIdFrom(searchParams)}/monitoring`);
}
