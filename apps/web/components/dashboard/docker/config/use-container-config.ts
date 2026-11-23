"use client";

import { useDockerInspectQuery } from "@/lib/host-data";

// `docker inspect` of a container. Each read is
// an agent job, so dialogs only ask once they are opened.
export function useContainerConfig<T = Record<string, any>>(
	containerId: string,
	serverId: string | undefined,
	enabled: boolean,
) {
	return useDockerInspectQuery<T>(
		serverId || undefined,
		containerId ? { type: "containerInspect", containerId } : null,
		enabled && !!containerId,
	);
}
