"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";
import { useServerNames } from "@/components/servers/use-server-states";
import { isServiceKind, type ServiceRef, serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";

export type DirectoryService = {
	id: string;
	name: string;
	appName: string;
	ref: ServiceRef | null;
	projectName: string;
	environmentName: string;
	serverId: string | null;
	href: string | null;
};

/** Every service the member can see, by id and by app name, plus server
    names: what Activity rows need to say "project / service" and link. */
export function useDirectory() {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const projects = useQuery(
		api.projects.all,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	const servers = useServerNames();
	return useMemo(() => {
		const byId = new Map<string, DirectoryService>();
		const byAppName = new Map<string, DirectoryService>();
		for (const project of projects ?? []) {
			for (const environment of project.environments) {
				for (const service of environment.services) {
					const ref = isServiceKind(service.type)
						? {
								projectId: project.projectId,
								environmentId: environment.environmentId,
								kind: service.type,
								id: service.id,
							}
						: null;
					const entry: DirectoryService = {
						id: service.id,
						name: service.name,
						appName: service.appName,
						ref,
						projectName: project.name,
						environmentName: environment.name,
						serverId: service.serverId,
						href: ref ? serviceUrl(ref) : null,
					};
					byId.set(service.id, entry);
					byAppName.set(service.appName, entry);
				}
			}
		}
		const serverNames = new Map<string, string>(
			(servers ?? []).map((server) => [server._id as string, server.name]),
		);
		return {
			loaded: projects !== undefined,
			byId,
			byAppName,
			serverNames,
			servers: servers ?? [],
			projects: projects ?? [],
		};
	}, [projects, servers]);
}

/** Traefik's service name (`<appName>-service-<domain>@file`) → the service. */
export function serviceOfTraefikName(
	name: string | undefined,
	byAppName: Map<string, DirectoryService>,
) {
	if (!name) return undefined;
	const bare = name.replace(/@[a-z]+$/, "");
	const index = bare.lastIndexOf("-service-");
	return byAppName.get(index > 0 ? bare.slice(0, index) : bare);
}

export const formatDuration = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatShortDuration = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest
		? `${minutes} min ${String(rest).padStart(2, "0")} s`
		: `${minutes} min`;
};
