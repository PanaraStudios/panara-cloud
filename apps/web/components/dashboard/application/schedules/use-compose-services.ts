"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

// The compose's service names: "cache" reads the compose file on
// the host, "fetch" clones the source again. Loading runs as an agent job;
// the names land on the compose row.
export function useComposeServices(
	composeId: string | undefined,
	type: "fetch" | "cache",
	enabled: boolean,
) {
	const id = composeId ? (composeId as Id<"compose">) : undefined;
	const compose = useQuery(
		api.compose.crud.get,
		enabled && id ? { composeId: id } : "skip",
	);
	const loadServices = useMutation(api.compose.deploy.loadServices);
	const [opId, setOpId] = useState<Id<"composeOps"> | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const op = useQuery(api.compose.deploy.getOp, opId ? { opId } : "skip");

	const refetch = () => {
		if (!id) return;
		setRequestError(null);
		loadServices({ composeId: id, fetch: type === "fetch" })
			.then((result) => setOpId(result.opId))
			.catch((error: unknown) => setRequestError(errorMessage(error)));
	};

	useEffect(() => {
		if (enabled && id) refetch();
	}, [enabled, id, type]);

	const message = requestError ?? op?.error ?? null;
	return {
		data: compose?.services,
		isFetching: opId !== null && !op?.completedAt && !op?.error,
		error: message ? new Error(message) : null,
		refetch,
	};
}
