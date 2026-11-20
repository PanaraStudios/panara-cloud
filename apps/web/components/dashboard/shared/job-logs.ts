"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { type LogLine, parseLogs } from "../docker/logs/utils";

export type JobId = Id<"jobs">;

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

// Follows a job's log chunks. The query window is bounded, so it advances `afterSeq` as
// chunks arrive and keeps what it has seen.
export const useJobLogs = (jobId: JobId | null | undefined) => {
	const [lines, setLines] = useState<LogLine[]>([]);
	const [afterSeq, setAfterSeq] = useState<number | undefined>(undefined);
	const [trackedJob, setTrackedJob] = useState(jobId);

	if (trackedJob !== jobId) {
		setTrackedJob(jobId);
		setLines([]);
		setAfterSeq(undefined);
	}

	const chunks = useQuery(api.jobs.logs, jobId ? { jobId, afterSeq } : "skip");
	const job = useQuery(api.jobs.get, jobId ? { jobId } : "skip");

	useEffect(() => {
		if (!chunks || chunks.length === 0) return;
		const last = chunks[chunks.length - 1];
		if (!last || last.seq === afterSeq) return;
		setLines((prev) => [
			...prev,
			...chunks.flatMap((chunk) => parseLogs(chunk.text)),
		]);
		setAfterSeq(last.seq);
	}, [chunks, afterSeq]);

	return {
		logs: lines,
		job: job ?? null,
		isFinished: !!job && FINISHED.has(job.status),
	};
};
