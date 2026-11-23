import { redirect } from "next/navigation";
import {
	param,
	type SearchParams,
	serverIdFrom,
} from "@/lib/redirects/old-routes";

const SECTIONS: Record<string, string> = {
	containers: "containers",
	swarm: "cluster",
	images: "images",
	volumes: "volumes",
	networks: "networks",
};

export default async function Page({
	searchParams,
}: {
	searchParams: SearchParams;
}) {
	const server = await serverIdFrom(searchParams);
	const tab = (await param(searchParams, "tab")) ?? "containers";
	const section = SECTIONS[tab];
	redirect(`/servers/${server}${section ? `/${section}` : ""}`);
}
