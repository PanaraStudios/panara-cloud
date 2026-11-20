"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";

export const composeIdOf = (id: string) => id as Id<"compose">;

// The compose row in the flat shape the compose screens read:
// `composeStatus`, `composeId`, ...
export const useCompose = (composeId: string | undefined) => {
	const data = useQuery(
		api.compose.crud.one,
		composeId ? { composeId: composeIdOf(composeId) } : "skip",
	);
	// Memoized on the query result: screens reset their forms when it changes.
	return useMemo(
		() =>
			data
				? {
						...data,
						composeId: data._id,
						composeStatus: data.status,
						serverId: data.serverId ?? null,
						environment: {
							...(data.environment ?? { _id: data.environmentId, name: "" }),
							environmentId: data.environmentId,
							projectId: data.projectId,
						},
					}
				: data,
		[data],
	);
};

export type ComposeData = NonNullable<ReturnType<typeof useCompose>>;

type OpStart = Promise<{ opId: Id<"composeOps"> }>;

// Host operations (load services, convert, load mounts) run as jobs whose
// result lands in a `composeOps` row; this follows the latest one started.
export const useComposeOp = () => {
	const [opId, setOpId] = useState<Id<"composeOps"> | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const op = useQuery(api.compose.deploy.getOp, opId ? { opId } : "skip");
	const job = useQuery(
		api.jobs.get,
		op?.jobId && op.completedAt === undefined ? { jobId: op.jobId } : "skip",
	);
	const jobFailed =
		!!job && (job.status === "failed" || job.status === "cancelled");
	const done = !!op && (op.completedAt !== undefined || jobFailed);
	const opError =
		op?.error ?? (jobFailed ? (job?.error ?? "The operation failed") : null);
	return {
		run: async (start: () => OpStart) => {
			setStarting(true);
			setStartError(null);
			try {
				const { opId } = await start();
				setOpId(opId);
				return opId;
			} catch (error) {
				setStartError(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				setStarting(false);
			}
		},
		result: done ? (op?.result ?? null) : null,
		error: startError ?? (done ? opError : null),
		isPending: starting || (!!opId && !done),
		opId,
	};
};

const CONTAINERS_REFRESH_MS = 15_000;

// The compose's containers from the
// host's latest `containers` snapshot, refreshed on mount and periodically
// while `poll` is set (each refresh is an agent job).
export const useComposeContainers = (
	composeId: string | undefined,
	options: { enabled?: boolean; poll?: boolean } = {},
) => {
	const enabled = (options.enabled ?? true) && !!composeId;
	const id = composeId ? composeIdOf(composeId) : null;
	const data = useQuery(
		api.compose.containers.list,
		enabled && id ? { composeId: id } : "skip",
	);
	const refreshMutation = useMutation(api.compose.containers.refresh);
	const [refreshJobId, setRefreshJobId] = useState<Id<"jobs"> | null>(null);
	const refreshJob = useQuery(
		api.jobs.get,
		refreshJobId ? { jobId: refreshJobId } : "skip",
	);
	const refreshing =
		!!refreshJobId &&
		(refreshJob === undefined ||
			refreshJob?.status === "queued" ||
			refreshJob?.status === "running");

	const refetch = useCallback(async () => {
		if (!id) return;
		try {
			setRefreshJobId(await refreshMutation({ composeId: id }));
		} catch {
			setRefreshJobId(null);
		}
	}, [id, refreshMutation]);

	useEffect(() => {
		if (!enabled) return;
		void refetch();
		if (!options.poll) return;
		const timer = setInterval(() => void refetch(), CONTAINERS_REFRESH_MS);
		return () => clearInterval(timer);
	}, [enabled, options.poll, refetch]);

	return {
		data: data?.containers,
		error: data?.error ?? null,
		isPending: data === undefined || (refreshing && !data.refreshedAt),
		isRefreshing: refreshing,
		refetch,
	};
};
