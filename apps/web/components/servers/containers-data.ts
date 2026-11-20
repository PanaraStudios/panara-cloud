"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import { useSnapshot } from "@/lib/host-data";
import { isServiceKind, type ServiceRef, serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";

export type ContainerSnapshotRow = {
	containerId: string;
	name: string;
	image: string;
	ports: string;
	state: string;
	status: string;
};

export type OwningService = {
	label: string;
	href: string | null;
	appName: string;
};

export type ContainerRow = ContainerSnapshotRow & {
	owner: OwningService | null;
	system: boolean;
};

const SEPARATORS = new Set([".", "-", "_"]);

// Swarm tasks are `<appName>.<slot>.<task>`, compose containers
// `<appName>-<service>-<n>` and stack tasks `<appName>_<service>.<slot>.<task>`;
// the longest matching appName wins.
export function matchAppName<T extends { appName: string }>(
	containerName: string,
	candidates: T[],
): T | null {
	const name = containerName.replace(/^\//, "");
	let best: T | null = null;
	for (const candidate of candidates) {
		const appName = candidate.appName;
		if (!appName) continue;
		const matches =
			name === appName ||
			(name.startsWith(appName) && SEPARATORS.has(name[appName.length] ?? ""));
		if (matches && (!best || appName.length > best.appName.length)) {
			best = candidate;
		}
	}
	return best;
}

export const isSystemContainer = (name: string) =>
	name.replace(/^\//, "").startsWith("panara-cloud");

/** Every service of the organization by appName, for "Belongs to" columns. */
export function useServiceDirectory() {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const projects = useQuery(
		api.projects.all,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	return useMemo(
		() =>
			(projects ?? []).flatMap((project) =>
				project.environments.flatMap((environment) =>
					environment.services.map((service) => {
						const ref: ServiceRef | null = isServiceKind(service.type)
							? {
									projectId: project.projectId,
									environmentId: environment.environmentId,
									kind: service.type,
									id: service.id,
								}
							: null;
						return {
							appName: service.appName ?? "",
							label: `${project.name} / ${service.name}`,
							href: ref ? serviceUrl(ref) : null,
						} satisfies OwningService;
					}),
				),
			),
		[projects],
	);
}

/** The server's containers with the service each one belongs to. */
export function useServerContainers(
	serverId: string | undefined,
	options: { refreshInterval?: number; enabled?: boolean } = {},
) {
	const snapshot = useSnapshot<ContainerSnapshotRow[]>(serverId, "containers", {
		refreshInterval: options.refreshInterval,
		enabled: options.enabled,
	});
	const services = useServiceDirectory();
	const rows = useMemo<ContainerRow[] | undefined>(
		() =>
			snapshot.data?.map((container) => ({
				...container,
				name: container.name.replace(/^\//, ""),
				owner: matchAppName(container.name, services),
				system: isSystemContainer(container.name),
			})),
		[snapshot.data, services],
	);
	return { ...snapshot, rows };
}

export type ContainerStatus = {
	tone: BadgeTone;
	label: string;
	note?: string;
};

export function containerStatus(
	container: Pick<ContainerSnapshotRow, "state" | "status">,
): ContainerStatus {
	const status = container.status ?? "";
	const code = /\((\d+)\)/.exec(status)?.[1];
	switch (container.state) {
		case "running": {
			const health = /\((healthy|unhealthy|health: starting)\)/.exec(
				status,
			)?.[1];
			return {
				tone: health === "unhealthy" ? "warning" : "success",
				label: "Running",
				note: health === "health: starting" ? "starting" : health,
			};
		}
		case "restarting":
			return {
				tone: "warning",
				label: "Restarting",
				note: code ? `exit ${code}` : undefined,
			};
		case "exited":
			return code && code !== "0"
				? { tone: "destructive", label: "Exited", note: `code ${code}` }
				: { tone: "secondary", label: "Stopped" };
		case "dead":
			return { tone: "destructive", label: "Dead" };
		case "paused":
			return { tone: "secondary", label: "Paused" };
		case "created":
			return { tone: "secondary", label: "Created" };
		case "removing":
			return { tone: "secondary", label: "Removing" };
		default:
			return { tone: "secondary", label: container.state || "Unknown" };
	}
}

const UNITS: [RegExp, string][] = [
	[/^seconds?$/, "s"],
	[/^minutes?$/, "min"],
	[/^hours?$/, "h"],
	[/^days?$/, "d"],
	[/^weeks?$/, "wk"],
	[/^months?$/, "mo"],
	[/^years?$/, "y"],
];

// "Up 2 hours (healthy)" → "2 h"; "Restarting (137) 14 seconds ago" → "14 s".
export function containerUptime(status: string): string | null {
	const match =
		/^Up (.+?)(?: \(.*\))?$/.exec(status) ??
		/^Restarting \(\d+\) (.+?) ago$/.exec(status);
	if (!match?.[1]) return null;
	const text = match[1]
		.replace(/^Less than a second$/, "1 second")
		.replace(/^About an? /, "1 ");
	const [amount, unit] = text.split(" ");
	const short = UNITS.find(([pattern]) => pattern.test(unit ?? ""))?.[1];
	return short ? `${amount} ${short}` : text;
}
