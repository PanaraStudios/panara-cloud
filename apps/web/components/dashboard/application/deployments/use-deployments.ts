"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TimeMark } from "@/lib/log-entries";
import { useOrganization } from "@/lib/organization";

export type DeploymentType =
	| "application"
	| "compose"
	| "schedule"
	| "server"
	| "backup"
	| "previewDeployment"
	| "volumeBackup";

export type DeploymentStatus =
	| "queued"
	| "running"
	| "done"
	| "error"
	| "cancelled";

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

// `deployments.target.kind` for each deployment type the screens use.
const TARGET_KINDS: Record<DeploymentType, string> = {
	application: "application",
	compose: "compose",
	schedule: "schedule",
	server: "server",
	backup: "databaseBackup",
	previewDeployment: "preview",
	volumeBackup: "volumeBackup",
};

export const toDeploymentStatus = (status: JobStatus): DeploymentStatus =>
	status === "succeeded" ? "done" : status === "failed" ? "error" : status;

const toIso = (time: number | undefined) =>
	time === undefined ? null : new Date(time).toISOString();

// Deploy history in the shape the deployment screens read (`deploymentId`,
// ISO dates, `done` / `error` statuses); the logs are read from the run's job.
export function useDeployments(id: string, type: DeploymentType) {
	const { active, canManage } = useOrganization();
	// Host history is admin-only (the query would throw for members).
	const allowed = type !== "server" || canManage;
	const rows = useQuery(
		api.jobs.deployments,
		id && allowed
			? {
					organizationId: active.id,
					target: { kind: TARGET_KINDS[type], id },
				}
			: "skip",
	);
	const rollbacks = useQuery(
		api.applications.rollbacks.list,
		id && type === "application"
			? { applicationId: id as Id<"applications"> }
			: "skip",
	);
	return useMemo(() => {
		if (!allowed) return [];
		if (rows === undefined) return undefined;
		const byDeployment = new Map(
			(rollbacks ?? []).flatMap((rollback) =>
				rollback.deploymentId
					? [[rollback.deploymentId as string, rollback] as const]
					: [],
			),
		);
		return rows.map((row) => {
			const rollback = byDeployment.get(row._id);
			return {
				deploymentId: row._id,
				jobId: row.jobId,
				title: row.title,
				description: row.description ?? null,
				status: toDeploymentStatus(row.status),
				createdAt: new Date(row._creationTime).toISOString(),
				startedAt: toIso(row.startedAt),
				finishedAt: toIso(row.finishedAt),
				errorMessage: row.error ?? null,
				logPath: row.jobId as string,
				buildServerId: null as string | null,
				rollback: rollback
					? { rollbackId: rollback._id, version: rollback.version }
					: null,
			};
		});
	}, [allowed, rows, rollbacks]);
}

export type Deployment = NonNullable<ReturnType<typeof useDeployments>>[number];

const LOG_PAGE = 200;

interface JobLog {
	text: string;
	/** When each chunk reached the backend, by where it starts in `text`. */
	marks: TimeMark[];
}

const NO_LOG: JobLog = { text: "", marks: [] };

// The full log of a job, following new chunks as the agent appends them.
// `api.jobs.logs` returns a window after `afterSeq`; the cursor moves past
// every page read, so the live subscription only ever carries new chunks.
// The agent sends a chunk every moment or so while a job prints, so a
// chunk's arrival is the time of its lines.
export function useJobLogs(jobId: string | null | undefined) {
	const [log, setLog] = useState<JobLog>(NO_LOG);
	const [cursor, setCursor] = useState<number | undefined>(undefined);
	const lastSeq = useRef<number | undefined>(undefined);
	const id = jobId ? (jobId as Id<"jobs">) : null;

	useEffect(() => {
		setLog(NO_LOG);
		setCursor(undefined);
		lastSeq.current = undefined;
	}, [id]);

	const page = useQuery(
		api.jobs.logs,
		id ? { jobId: id, afterSeq: cursor, limit: LOG_PAGE } : "skip",
	);

	useEffect(() => {
		if (!page || page.length === 0) return;
		const fresh = page.filter(
			(chunk) => lastSeq.current === undefined || chunk.seq > lastSeq.current,
		);
		if (fresh.length === 0) return;
		const last = fresh[fresh.length - 1]?.seq;
		lastSeq.current = last;
		setLog((previous) => {
			let text = previous.text;
			const marks = [...previous.marks];
			for (const chunk of fresh) {
				marks.push({ offset: text.length, at: chunk._creationTime });
				text += chunk.text;
			}
			return { text, marks };
		});
		setCursor(last);
	}, [page]);

	return {
		text: log.text,
		marks: log.marks,
		isLoading: id !== null && page === undefined && !log.text,
	};
}
