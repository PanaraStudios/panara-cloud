import { param, serverIdFrom } from "@/lib/redirects/old-routes";
import { redirect, useSearchParams } from "@/lib/router";

const SECTIONS: Record<string, string> = {
	containers: "containers",
	swarm: "cluster",
	images: "images",
	volumes: "volumes",
	networks: "networks",
};

export default function Page() {
	const searchParams = useSearchParams();
	const server = serverIdFrom(searchParams);
	const tab = param(searchParams, "tab") ?? "containers";
	const section = SECTIONS[tab];
	redirect(`/servers/${server}${section ? `/${section}` : ""}`);
}
