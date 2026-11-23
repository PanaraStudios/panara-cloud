"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useMemo } from "react";
import {
	type ServiceKind,
	serviceTarget,
	settingsSectionForEvent,
} from "@/lib/navigation";

export type PendingChanges = FunctionReturnType<
	typeof api.serviceEvents.pendingChanges
>;
export type PendingEvent = PendingChanges["events"][number];

/** `serviceEvents.pendingChanges` for a route's service; undefined while loading. */
// The query throws for a missing service, so callers pass `id` only once
// they know it exists.
export function usePendingChanges(kind: ServiceKind, id: string | undefined) {
	const { isAuthenticated } = useConvexAuth();
	return useQuery(
		api.serviceEvents.pendingChanges,
		isAuthenticated && id ? { target: serviceTarget(kind, id) } : "skip",
	);
}

/** Settings sections with changes waiting for a deploy. */
export function usePendingSections(kind: ServiceKind, id: string | undefined) {
	const pending = usePendingChanges(kind, id);
	return useMemo(() => {
		const sections = new Set<string>();
		for (const event of pending?.events ?? []) {
			const section = settingsSectionForEvent(kind, event.type);
			if (section) sections.add(section);
		}
		return sections;
	}, [pending, kind]);
}
