"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useCallback, useState } from "react";
import {
	type SnapshotKind,
	useHostSnapshot,
	useWaitForJob,
} from "../host-jobs";

type SecurityAction = FunctionArgs<
	typeof api.infra.serverSecurity.run
>["action"];

// A host snapshot in the shape the security tabs read.
export function useSecurityQuery<T>(serverId: string, kind: SnapshotKind) {
	const snapshot = useHostSnapshot<T>(serverId, kind);
	const refetch = useCallback(
		() => snapshot.refresh().catch(() => undefined),
		[snapshot.refresh],
	);
	if (snapshot.data === null) {
		if (snapshot.error) {
			return {
				data: undefined,
				isPending: false as const,
				isError: true as const,
				error: { message: snapshot.error },
				refetch,
				isRefetching: snapshot.isRefreshing,
			};
		}
		return {
			data: undefined,
			isPending: true as const,
			isError: false as const,
			error: null,
			refetch,
			isRefetching: snapshot.isRefreshing,
		};
	}
	return {
		data: snapshot.data,
		isPending: false as const,
		isError: false as const,
		error: null,
		refetch,
		isRefetching: snapshot.isRefreshing,
	};
}

// Runs a security action on the server and resolves once the agent applied
// it (rejecting with its error).
export function useSecurityAction() {
	const run = useMutation(api.infra.serverSecurity.run);
	const waitForJob = useWaitForJob();
	const [isPending, setIsPending] = useState(false);
	const mutateAsync = useCallback(
		async (serverId: string, action: SecurityAction) => {
			setIsPending(true);
			try {
				await waitForJob(
					await run({ serverId: serverId as Id<"servers">, action }),
				);
			} finally {
				setIsPending(false);
			}
		},
		[run, waitForJob],
	);
	return { mutateAsync, isPending };
}
