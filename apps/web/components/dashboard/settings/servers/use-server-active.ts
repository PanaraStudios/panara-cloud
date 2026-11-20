"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";

// `server.serverStatus === "active"` for the server badge on
// service pages; the panel host (no server) is always active.
export const useServerActive = (serverId: string | null | undefined) => {
	const server = useQuery(
		api.servers.get,
		serverId ? { serverId: serverId as Id<"servers"> } : "skip",
	);
	return !serverId || server?.serverStatus !== "inactive";
};
