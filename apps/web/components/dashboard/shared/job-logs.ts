"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";

export type JobId = Id<"jobs">;

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

/** A job a form started, and whether it is over. Its output is on its page
    (`/activity/jobs/<id>`). */
export const useJobStatus = (jobId: JobId | null | undefined) => {
	const job = useQuery(api.jobs.get, jobId ? { jobId } : "skip");
	return {
		job: job ?? null,
		isFinished: !!job && FINISHED.has(job.status),
	};
};
