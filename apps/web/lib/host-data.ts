"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import {
	type ConvexReactClient,
	type RequestForQueries,
	useConvex,
	useMutation,
	useQueries,
} from "convex/react";
import {
	type FunctionArgs,
	type FunctionReference,
	type FunctionReturnType,
	getFunctionName,
	makeFunctionReference,
} from "convex/server";
import type { Value } from "convex/values";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LiveMessage, type LiveRequest, useLiveSession } from "@/lib/live";

export type SnapshotKind = FunctionArgs<typeof api.infra.snapshots.get>["kind"];

const OP_TIMEOUT_MS = 120_000;

const asServerId = (serverId: string | undefined) =>
	serverId as Id<"servers"> | undefined;

// Like useQuery, but a failed query (no access to the panel host, server
// removed) comes back as an Error value instead of throwing into the page.
export function useQueryResult<Query extends FunctionReference<"query">>(
	query: Query,
	args: FunctionArgs<Query> | "skip",
): FunctionReturnType<Query> | Error | undefined {
	const key = args === "skip" ? null : JSON.stringify(args);
	// `api.x.y` is a fresh proxy on every access, so memoize on the function's
	// name; otherwise useQueries resubscribes on every render and loops.
	const name = getFunctionName(query);
	const queries = useMemo((): RequestForQueries => {
		if (key === null) return {};
		return {
			result: {
				query: makeFunctionReference<"query">(name),
				args: JSON.parse(key) as Record<string, Value>,
			},
		};
	}, [name, key]);
	return useQueries(queries).result as
		| FunctionReturnType<Query>
		| Error
		| undefined;
}

// Live host state (containers, images, volumes, ...) read from the agent's
// latest `infraSnapshots` row. Mounting the hook queues a refresh, and
// `refreshInterval` keeps refreshing while it stays mounted.
export function useSnapshot<T>(
	serverId: string | undefined,
	kind: SnapshotKind,
	options: { enabled?: boolean; refreshInterval?: number } = {},
) {
	const enabled = options.enabled ?? true;
	const snapshot = useQueryResult(
		api.infra.snapshots.get,
		enabled ? { serverId: asServerId(serverId), kind } : "skip",
	);
	const refreshMutation = useMutation(api.infra.snapshots.refresh);
	const [requestError, setRequestError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setRequestError(null);
			await refreshMutation({ serverId: asServerId(serverId), kind });
		} catch (error) {
			setRequestError(error instanceof Error ? error.message : String(error));
		}
	}, [refreshMutation, serverId, kind]);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
		if (!options.refreshInterval) return;
		const timer = setInterval(() => void refresh(), options.refreshInterval);
		return () => clearInterval(timer);
	}, [enabled, refresh, options.refreshInterval]);

	const raw = snapshot instanceof Error ? null : snapshot?.data;
	const data = useMemo(() => {
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}, [raw]);

	const isRefreshing = !(snapshot instanceof Error) && !!snapshot?.pendingJobId;
	const error =
		requestError ??
		(snapshot instanceof Error ? snapshot.message : snapshot?.error) ??
		null;
	return {
		data,
		error,
		refreshedAt:
			(snapshot instanceof Error ? null : snapshot?.refreshedAt) ?? null,
		isRefreshing,
		// Nothing to show yet: the first read is still on its way.
		isLoading:
			enabled &&
			!error &&
			(snapshot === undefined || (data === undefined && isRefreshing)),
		refresh,
	};
}

type OpResult = {
	status: string | null;
	result: string | null;
	error: string | null;
} | null;

const settle = <T>(
	convex: ConvexReactClient,
	jobId: Id<"jobs">,
	read: (
		value: OpResult,
	) => { done: false } | { done: true; value?: T; error?: string },
	timeoutMs: number,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const watch = convex.watchQuery(api.infra.snapshots.opResult, { jobId });
		let unsubscribe: (() => void) | null = null;
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			unsubscribe?.();
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error("The agent did not answer in time"))),
			timeoutMs,
		);
		const check = () => {
			let value: OpResult | undefined;
			try {
				value = watch.localQueryResult() as OpResult | undefined;
			} catch (error) {
				finish(() => reject(error));
				return;
			}
			if (value === undefined) return;
			const outcome = read(value);
			if (!outcome.done) return;
			finish(() =>
				outcome.error !== undefined
					? reject(new Error(outcome.error))
					: resolve(outcome.value as T),
			);
		};
		unsubscribe = watch.onUpdate(check);
		check();
	});

// Waits for the result of a one-off agent job (inspect, Traefik file read)
// queued by a mutation that returned its job id.
export function waitForOp<T>(
	convex: ConvexReactClient,
	jobId: Id<"jobs">,
	timeoutMs = OP_TIMEOUT_MS,
): Promise<T> {
	return settle<T>(
		convex,
		jobId,
		(op) => {
			if (!op) return { done: false };
			if (op.error) return { done: true, error: op.error };
			if (op.result !== null) {
				return { done: true, value: JSON.parse(op.result) as T };
			}
			if (op.status === "failed" || op.status === "cancelled") {
				return { done: true, error: `The job ${op.status}` };
			}
			return { done: false };
		},
		timeoutMs,
	);
}

// Waits until a queued job finishes; rejects with its error when it fails.
export function waitForJob(
	convex: ConvexReactClient,
	jobId: Id<"jobs">,
	timeoutMs = OP_TIMEOUT_MS,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const watch = convex.watchQuery(api.jobs.get, { jobId });
		let unsubscribe: (() => void) | null = null;
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			unsubscribe?.();
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error("The agent did not answer in time"))),
			timeoutMs,
		);
		const check = () => {
			let job: { status: string; error?: string } | null | undefined;
			try {
				job = watch.localQueryResult();
			} catch (error) {
				finish(() => reject(error));
				return;
			}
			if (job === undefined) return;
			if (job === null) {
				finish(() => reject(new Error("Job not found")));
			} else if (job.status === "succeeded") {
				finish(resolve);
			} else if (job.status === "failed" || job.status === "cancelled") {
				finish(() => reject(new Error(job?.error ?? `The job ${job?.status}`)));
			}
		};
		unsubscribe = watch.onUpdate(check);
		check();
	});
}

// Reactive result of a one-off agent job; `undefined` while it runs.
export function useOpResult<T>(jobId: Id<"jobs"> | null | undefined) {
	const result = useQueryResult(
		api.infra.snapshots.opResult,
		jobId ? { jobId } : "skip",
	);
	const op = result instanceof Error ? null : result;
	const data = useMemo(() => {
		if (!op?.result) return undefined;
		try {
			return JSON.parse(op.result) as T;
		} catch {
			return undefined;
		}
	}, [op?.result]);
	const failed = op?.status === "failed" || op?.status === "cancelled";
	return {
		data,
		error:
			(result instanceof Error ? result.message : op?.error) ??
			(failed ? `The job ${op?.status}` : null),
		isLoading:
			!!jobId &&
			data === undefined &&
			!op?.error &&
			!failed &&
			!(result instanceof Error),
	};
}

// Runs an inspect-style docker action and resolves with its result, e.g.
// `inspect({ type: "containerInspect", containerId })`.
export function useDockerInspect() {
	const run = useMutation(api.infra.docker.run);
	const convex = useConvex();
	return useCallback(
		async <T = unknown>(
			serverId: string | undefined,
			action: FunctionArgs<typeof api.infra.docker.run>["action"],
		) => {
			const jobId = await run({ serverId: asServerId(serverId), action });
			return await waitForOp<T>(convex, jobId);
		},
		[run, convex],
	);
}

// Same as useDockerInspect but as a reactive value for a dialog that opens
// with `enabled`.
export function useDockerInspectQuery<T = unknown>(
	serverId: string | undefined,
	action: FunctionArgs<typeof api.infra.docker.run>["action"] | null,
	enabled = true,
) {
	const inspect = useDockerInspect();
	const [state, setState] = useState<{
		data: T | undefined;
		error: string | null;
		isLoading: boolean;
	}>({ data: undefined, error: null, isLoading: false });
	const key = enabled && action ? JSON.stringify([serverId, action]) : null;
	useEffect(() => {
		if (!key || !action) return;
		let cancelled = false;
		setState({ data: undefined, error: null, isLoading: true });
		inspect<T>(serverId, action).then(
			(data) => !cancelled && setState({ data, error: null, isLoading: false }),
			(error: unknown) =>
				!cancelled &&
				setState({
					data: undefined,
					error: error instanceof Error ? error.message : String(error),
					isLoading: false,
				}),
		);
		return () => {
			cancelled = true;
		};
	}, [key]);
	return state;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onMessage?: (message: LiveMessage) => void;
};

// Request/response calls over an agent live session (files, access log,
// sandbox): `call(op, payload)` resolves with the matching `result` frame.
export function useLiveRpc(
	request: LiveRequest | null,
	onEvent?: (message: LiveMessage) => void,
	options: { reconnect?: boolean } = {},
) {
	const pending = useRef(new Map<string, Pending>());
	const queue = useRef<{ id: string; message: object }[]>([]);
	const counter = useRef(0);
	const eventHandler = useRef(onEvent);
	eventHandler.current = onEvent;

	const session = useLiveSession(
		request,
		(message) => {
			if ("id" in message && typeof message.id === "string") {
				const entry = pending.current.get(message.id);
				if (entry) {
					if (message.type === "result") {
						pending.current.delete(message.id);
						if (message.ok) entry.resolve(message.data);
						else entry.reject(new Error(message.error));
						return;
					}
					entry.onMessage?.(message);
					if (message.type === "exit") {
						pending.current.delete(message.id);
						entry.resolve(message);
					}
					return;
				}
			}
			eventHandler.current?.(message);
		},
		options,
	);

	const { status, send } = session;
	const live = useRef({ status, send });
	live.current = { status, send };
	useEffect(() => {
		if (status === "open") {
			for (const { message } of queue.current.splice(0))
				live.current.send(message);
			return;
		}
		// Calls already sent get no answer from a closed socket; queued ones
		// still go out if the session reconnects.
		const keep =
			status === "connecting"
				? new Set(queue.current.map(({ id }) => id))
				: new Set<string>();
		if (status !== "connecting") queue.current = [];
		for (const [id, entry] of pending.current) {
			if (keep.has(id)) continue;
			pending.current.delete(id);
			entry.reject(new Error(session.error ?? "Connection closed"));
		}
	}, [status, session.error]);

	const call = useCallback(
		<T = unknown>(
			op: string,
			payload: Record<string, unknown> = {},
			onMessage?: (message: LiveMessage) => void,
		): Promise<T> => {
			counter.current += 1;
			const id = `r${counter.current}`;
			const message = { ...payload, type: op, id };
			return new Promise<T>((resolve, reject) => {
				pending.current.set(id, {
					resolve: resolve as (value: unknown) => void,
					reject,
					onMessage,
				});
				if (live.current.status === "open") live.current.send(message);
				else queue.current.push({ id, message });
			});
		},
		[],
	);

	return { status, error: session.error, call };
}
