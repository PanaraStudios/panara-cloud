"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQueries } from "convex/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { cancelOutcome, TOO_LATE_TO_CANCEL } from "@/lib/cancel-outcome";

// The jobs somebody on this page asked to cancel, until each has ended. Kept
// outside the components: the button that cancels (a service's "Deploying |
// Cancel", a row's menu) is gone as soon as its job ends, which is exactly
// when there is something to say.
type Watched = { jobId: Id<"jobs">; cancelling: string };
const NONE: readonly Watched[] = [];
let watched: readonly Watched[] = NONE;
const listeners = new Set<() => void>();
const setWatched = (next: readonly Watched[]) => {
	watched = next;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** Cancels a job; `CancelOutcomes` then says how that ended. `cancelling`
    is what is said while the agent stops the work. */
export function useCancelJob(cancelling = "Cancelling") {
	const cancel = useMutation(api.jobs.cancel);
	return useCallback(
		async (jobId: Id<"jobs">) => {
			await cancel({ jobId });
			if (!watched.some((entry) => entry.jobId === jobId)) {
				setWatched([...watched, { jobId, cancelling }]);
			}
		},
		[cancel, cancelling],
	);
}

/** Mounted once in the app shell: says "Cancelling" while a cancelled job is
    still being stopped, then "Cancelled", or that it was too late when the
    job had finished all the same (the new container was already starting). */
export function CancelOutcomes() {
	const entries = useSyncExternalStore(
		subscribe,
		() => watched,
		() => NONE,
	);
	// Jobs whose "Cancelling" has been said.
	const announced = useRef(new Set<string>());
	const queries = useMemo(
		() =>
			Object.fromEntries(
				entries.map(({ jobId }) => [
					jobId,
					{ query: api.jobs.get, args: { jobId } },
				]),
			),
		[entries],
	);
	const jobs = useQueries(queries);

	useEffect(() => {
		const settled: string[] = [];
		for (const { jobId, cancelling } of entries) {
			const job = jobs[jobId] as { status: string } | null | Error | undefined;
			// A job that can't be read any more has nothing left to say.
			const outcome = job instanceof Error ? "failed" : cancelOutcome(job);
			if (outcome === "pending") {
				if (job !== undefined && !announced.current.has(jobId)) {
					announced.current.add(jobId);
					toast.success(cancelling);
				}
				continue;
			}
			settled.push(jobId);
			announced.current.delete(jobId);
			if (outcome === "cancelled") toast.success("Cancelled");
			if (outcome === "tooLate") {
				toast.warning(TOO_LATE_TO_CANCEL.title, {
					description: TOO_LATE_TO_CANCEL.description,
				});
			}
		}
		if (settled.length > 0) {
			setWatched(watched.filter((entry) => !settled.includes(entry.jobId)));
		}
	}, [entries, jobs]);

	return null;
}
