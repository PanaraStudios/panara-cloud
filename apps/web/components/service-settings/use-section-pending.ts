"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useMemo } from "react";
import { type ServiceKind, serviceTarget } from "@/lib/navigation";

export type PendingEvent = FunctionReturnType<
	typeof api.serviceEvents.pendingChanges
>["events"][number];

/** Changes waiting for a deploy, limited to the given event types. */
export function useSectionPending(
	kind: ServiceKind,
	id: string | undefined,
	types: readonly string[] | undefined,
) {
	const { isAuthenticated } = useConvexAuth();
	const pending = useQuery(
		api.serviceEvents.pendingChanges,
		isAuthenticated && id ? { target: serviceTarget(kind, id) } : "skip",
	);
	return useMemo(() => {
		const events = (pending?.events ?? []).filter(
			(event) => !types || types.includes(event.type),
		);
		return { events, primaryAction: pending?.primaryAction ?? null };
	}, [pending, types]);
}

/** Whether a row (domain host, port, mount path, name) has a change that is
    not deployed yet. */
export function isRowPending(
	events: readonly PendingEvent[],
	match: { host?: string; port?: number; path?: string; name?: string },
) {
	return events.some((event) => {
		const details = event.details;
		if (!details) return false;
		if (match.host !== undefined && details.host === match.host) return true;
		if (match.port !== undefined && details.port === match.port) return true;
		if (match.path !== undefined && details.path === match.path) return true;
		if (match.name !== undefined && details.name === match.name) return true;
		return false;
	});
}
