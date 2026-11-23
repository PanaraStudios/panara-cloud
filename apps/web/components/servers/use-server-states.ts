"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";
import { useOrganization } from "@/lib/organization";
import type { ServerState } from "@/lib/service-actions";

/** The servers the member may name (`servers.listNames`): all of them for
    whoever opens or places services on servers, else the ones their services
    are on. Undefined while loading. Pickers read this, never `servers.list`,
    which is empty without server.read. */
export function useServerNames(enabled = true) {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	return useQuery(
		api.servers.listNames,
		isAuthenticated && enabled ? { organizationId: active.id } : "skip",
	);
}

/** Whether each of those servers can take work, by id. The panel host has
    no row and is never in the map. */
export function useServerStates(enabled = true): Map<string, ServerState> {
	const servers = useServerNames(enabled);
	return useMemo(
		() =>
			new Map<string, ServerState>(
				(servers ?? []).map((server) => [server._id, server.state]),
			),
		[servers],
	);
}
