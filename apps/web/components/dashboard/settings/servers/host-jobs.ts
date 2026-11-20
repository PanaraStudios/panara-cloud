"use client";

import { api } from "@panara-cloud/backend/api";
import type { Doc, Id } from "@panara-cloud/backend/dataModel";
import {
	type ConvexReactClient,
	useConvex,
	useMutation,
	useQuery,
} from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type LogLine, parseLogs } from "../../docker/logs/utils";

export type SnapshotKind = FunctionArgs<typeof api.infra.snapshots.get>["kind"];

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

// Callers pass "" or undefined for the panel host; Convex wants undefined.
export const hostId = (serverId?: string | null) =>
	serverId ? (serverId as Id<"servers">) : undefined;

export const isJobFinished = (job: Pick<Doc<"jobs">, "status"> | null) =>
	!!job && FINISHED.has(job.status);

const watchUntil = <T, R>(
	watch: ReturnType<ConvexReactClient["watchQuery"]>,
	settle: (value: T) => R | undefined,
): Promise<R> =>
	new Promise<R>((resolve, reject) => {
		let unsubscribe: (() => void) | null = null;
		let done = false;
		const check = () => {
			if (done) return;
			let value: T | undefined;
			try {
				value = watch.localQueryResult() as T | undefined;
			} catch (error) {
				done = true;
				unsubscribe?.();
				reject(error);
				return;
			}
			if (value === undefined) return;
			const result = settle(value);
			if (result === undefined) return;
			done = true;
			unsubscribe?.();
			resolve(result);
		};
		unsubscribe = watch.onUpdate(check);
		check();
	});

// Resolves with the job once it finished (succeeded, failed or cancelled).
export const waitForJob = (client: ConvexReactClient, jobId: Id<"jobs">) =>
	watchUntil<Doc<"jobs"> | null, Doc<"jobs">>(
		client.watchQuery(api.jobs.get, { jobId }),
		(job) => {
			if (job === null) throw new Error("Job not found");
			return isJobFinished(job) ? job : undefined;
		},
	);

// Resolves with the parsed result of a one-off infra job (inspect, join
// tokens, Traefik files); rejects with the job's error.
export const waitForOp = <T = unknown>(
	client: ConvexReactClient,
	jobId: Id<"jobs">,
) =>
	watchUntil<
		{
			status: string | null;
			result: string | null;
			error: string | null;
		} | null,
		{ value: T }
	>(client.watchQuery(api.infra.snapshots.opResult, { jobId }), (op) => {
		if (!op?.status || !FINISHED.has(op.status)) return undefined;
		if (op.status !== "succeeded") {
			throw new Error(op.error ?? `Job ${op.status}`);
		}
		return { value: (op.result ? JSON.parse(op.result) : null) as T };
	}).then(({ value }) => value);

export function useWaitForJob() {
	const client = useConvex();
	return useCallback(
		async (jobId: Id<"jobs">) => {
			const job = await waitForJob(client, jobId);
			if (job.status !== "succeeded") {
				throw new Error(job.error ?? `Job ${job.status}`);
			}
			return job;
		},
		[client],
	);
}

export function useWaitForOp() {
	const client = useConvex();
	return useCallback(
		<T = unknown>(jobId: Id<"jobs">) => waitForOp<T>(client, jobId),
		[client],
	);
}

// Accumulates a job's log chunks (api.jobs.logs is windowed) into text and
// Parsed log lines.
export function useJobLogs(jobId: Id<"jobs"> | null) {
	const [state, setState] = useState<{
		jobId: Id<"jobs"> | null;
		seq: number | undefined;
		text: string;
	}>({ jobId: null, seq: undefined, text: "" });
	const current =
		state.jobId === jobId ? state : { jobId, seq: undefined, text: "" };
	const chunks = useQuery(
		api.jobs.logs,
		jobId ? { jobId, afterSeq: current.seq } : "skip",
	);
	const job = useQuery(api.jobs.get, jobId ? { jobId } : "skip");

	useEffect(() => {
		if (!jobId || !chunks || chunks.length === 0) return;
		setState((prev) => {
			const base =
				prev.jobId === jobId ? prev : { jobId, seq: undefined, text: "" };
			const fresh = chunks.filter(
				(chunk) => base.seq === undefined || chunk.seq > base.seq,
			);
			if (fresh.length === 0) return base;
			return {
				jobId,
				seq: fresh[fresh.length - 1]?.seq,
				text: base.text + fresh.map((chunk) => chunk.text).join(""),
			};
		});
	}, [jobId, chunks]);

	const lines: LogLine[] = useMemo(
		() => parseLogs(current.text),
		[current.text],
	);
	return { job: job ?? null, text: current.text, lines };
}

// Live host state (infra.snapshots): subscribes to the stored snapshot and
// asks the agent for a fresh read on mount and on `refresh()`.
export function useHostSnapshot<T>(
	serverId: string | undefined | null,
	kind: SnapshotKind,
	options: { enabled?: boolean; refreshOnMount?: boolean } = {},
) {
	const enabled = options.enabled ?? true;
	const refreshOnMount = options.refreshOnMount ?? true;
	const id = hostId(serverId);
	const snapshot = useQuery(
		api.infra.snapshots.get,
		enabled ? { serverId: id, kind } : "skip",
	);
	const refreshMutation = useMutation(api.infra.snapshots.refresh);
	const refresh = useCallback(
		() => refreshMutation({ serverId: id, kind }),
		[refreshMutation, id, kind],
	);

	useEffect(() => {
		if (enabled && refreshOnMount) refresh().catch(() => {});
	}, [enabled, refreshOnMount, refresh]);

	const raw = snapshot?.data ?? null;
	const data = useMemo(
		() => (raw === null ? null : (JSON.parse(raw) as T)),
		[raw],
	);
	const isRefreshing = !!snapshot?.pendingJobId;
	return {
		data,
		error: snapshot?.error ?? null,
		refreshedAt: snapshot?.refreshedAt ?? null,
		isRefreshing,
		isLoading:
			enabled &&
			(snapshot === undefined ||
				(raw === null && snapshot.error === null && isRefreshing)),
		refresh,
	};
}
