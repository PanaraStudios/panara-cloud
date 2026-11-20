"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { useOrganization } from "@/lib/organization";

// Some screens only know a container and its server, so
// live sessions use a host scope: admins reach the whole host, members only
// their organization's containers (the agent checks the labels).
export function useHostScope(serverId?: string | null) {
	const { active } = useOrganization();
	return {
		type: "host" as const,
		organizationId: active.id,
		serverId: serverId ? (serverId as Id<"servers">) : undefined,
	};
}
