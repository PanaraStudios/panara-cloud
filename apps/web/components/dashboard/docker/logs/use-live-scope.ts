"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";

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

/** The service a page of logs or containers belongs to, when it is one. */
export type ScopedService = {
	id: string;
	kind: "application" | "compose" | "database";
};

/**
 * The scope a service's own pages ask with. Whoever may read Docker on the
 * server asks for the host, as before. A member who was only granted the
 * service asks for that service alone: the backend lets them read it, and
 * the agent hands over nothing but its containers.
 */
export function useServiceOrHostScope(
	serverId: string | null | undefined,
	service: ScopedService | undefined,
) {
	const host = useHostScope(serverId);
	const canReadDocker = usePermissions().docker.read;
	if (!service || canReadDocker) return host;
	return {
		type: "service" as const,
		serviceKind: service.kind,
		serviceId: service.id,
	};
}
