"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

type CacheType = "cache" | "fetch";

// A compose's service names: loading them is a job whose results land on the
// compose row, so this starts one and follows it.
export const useComposeServices = (
	composeId: string | undefined,
	enabled: boolean,
) => {
	const id = composeId as Id<"compose"> | undefined;
	const compose = useQuery(
		api.compose.crud.one,
		enabled && id ? { composeId: id } : "skip",
	);
	const loadServices = useMutation(api.compose.deploy.loadServices);
	const [opId, setOpId] = useState<Id<"composeOps"> | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	const op = useQuery(api.compose.deploy.getOp, opId ? { opId } : "skip");

	const load = useCallback(
		async (cacheType: CacheType) => {
			if (!id) return;
			setStartError(null);
			try {
				const started = await loadServices({
					composeId: id,
					fetch: cacheType === "fetch",
				});
				setOpId(started.opId);
			} catch (error) {
				setStartError(
					error instanceof Error ? error.message : "Error loading services",
				);
			}
		},
		[id, loadServices],
	);

	const requested = useRef(false);
	useEffect(() => {
		if (!enabled) {
			requested.current = false;
			return;
		}
		if (requested.current || !compose || compose.services) return;
		requested.current = true;
		void load("cache");
	}, [enabled, compose, load]);

	const isLoading =
		opId !== null &&
		op !== null &&
		(op === undefined || (!op.completedAt && !op.error));
	const error = startError ?? op?.error ?? null;

	return {
		services: compose?.services,
		isLoading,
		error: error ? { message: error } : null,
		load,
	};
};
