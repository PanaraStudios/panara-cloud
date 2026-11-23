"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useOrganization } from "@/lib/organization";

type NetworkDoc = FunctionReturnType<typeof api.infra.networks.list>[number];

// A network row with the field names the network screens read.
export const toNetworkRow = (row: NetworkDoc) => ({
	...row,
	networkId: row._id as string,
	createdAt: new Date(row._creationTime).toISOString(),
	serverId: (row.serverId as string | undefined) ?? null,
});

export const asServerId = (serverId: string | undefined | null) =>
	(serverId ?? undefined) as Id<"servers"> | undefined;

export const asNetworkId = (networkId: string) => networkId as Id<"networks">;

// The organization's networks on one host (the panel host when serverId is
// undefined).
export function useNetworks(serverId: string | undefined | null) {
	const { active } = useOrganization();
	const rows = useQuery(api.infra.networks.list, {
		organizationId: active.id,
		serverId: asServerId(serverId),
	});
	return rows?.map(toNetworkRow);
}
