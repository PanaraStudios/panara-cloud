"use client";

import { useEffect, useMemo, useState } from "react";
import { type LiveRequest, useLiveSession } from "@/lib/live";
import { type ScopedService, useServiceOrHostScope } from "./use-live-scope";

export type HostContainer = {
	containerId: string;
	name: string;
	state: string;
	status: string;
};

// One swarm task of a service; its id is
// what `docker service logs` follows.
export type ServiceTask = {
	containerId: string;
	name: string;
	state: string;
	node: string;
	currentState: string;
	error: string;
};

type Mode = "native" | "swarm";

// A `serviceContainers` live session: the agent lists the service's
// containers (or swarm tasks) and re-sends the list whenever it changes.
// Members only get containers labelled with their organization.
function useServiceListing<T>(
	appName: string,
	serverId: string | undefined,
	mode: Mode,
	enabled: boolean,
	appType?: "stack" | "docker-compose",
	service?: ScopedService,
) {
	const scope = useServiceOrHostScope(serverId, service);
	const [rows, setRows] = useState<T[] | undefined>();
	const request = useMemo<LiveRequest | null>(
		() =>
			enabled && appName
				? { kind: "serviceContainers", scope, appName, appType, mode }
				: null,
		[enabled, appName, appType, mode, scope],
	);
	const key = request ? JSON.stringify(request) : null;
	useEffect(() => setRows(undefined), [key]);
	const session = useLiveSession(
		request,
		(message) => {
			if (message.type === "list" && Array.isArray(message.data)) {
				setRows(message.data as T[]);
			}
		},
		{ reconnect: true },
	);
	const failed = session.status === "error" || session.status === "closed";
	return {
		rows: request ? rows : undefined,
		isLoading: !!request && rows === undefined && !failed,
		error: failed && rows === undefined ? (session.error ?? null) : null,
	};
}

// The containers of a service, matched by app name.
export function useServiceContainers(
	appName: string,
	serverId: string | undefined,
	enabled = true,
	appType?: "stack" | "docker-compose",
	service?: ScopedService,
) {
	const { rows, isLoading, error } = useServiceListing<HostContainer>(
		appName,
		serverId,
		"native",
		enabled,
		appType,
		service,
	);
	return { containers: rows, isLoading, error };
}

// The swarm tasks of a service (or of a stack) with their node and error.
export function useServiceTasks(
	appName: string,
	serverId: string | undefined,
	enabled = true,
	appType?: "stack",
	service?: ScopedService,
) {
	const { rows, isLoading, error } = useServiceListing<ServiceTask>(
		appName,
		serverId,
		"swarm",
		enabled,
		appType,
		service,
	);
	return { tasks: rows, isLoading, error };
}
