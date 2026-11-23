"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex } from "convex/react";
import { useCallback } from "react";
import { waitForJob } from "../servers/host-jobs";

// Warns about failed Vector re-applies: waits for the re-apply jobs a
// provider update or removal queued and describes the ones that failed.
export function useReapplyWarning() {
	const client = useConvex();
	return useCallback(
		async (
			jobIds: Id<"jobs">[],
			targets: { serverId: string | null; name: string }[] | undefined,
		): Promise<string | undefined> => {
			const jobs = await Promise.all(
				jobIds.map((jobId) => waitForJob(client, jobId)),
			);
			const failures = jobs
				.filter((job) => job.status !== "succeeded")
				.map((job) => {
					const serverId = job.partition === "local" ? null : job.partition;
					const name =
						targets?.find((target) => target.serverId === serverId)?.name ??
						"Panara Cloud Server";
					return `${name}: ${job.error ?? job.status}`;
				});
			return failures.length > 0
				? `The Vector agent could not be re-applied on ${failures.join("; ")}`
				: undefined;
		},
		[client],
	);
}
