"use client";

import { useAction } from "convex/react";
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
} from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

const listeners = new Map<string, Set<() => void>>();

// Provider APIs (zones, records) are reached through Convex actions, which
// aren't reactive; mutations call this to make every reader of `key` refetch.
export const invalidateActionQuery = (key: string) => {
	for (const refetch of listeners.get(key) ?? []) refetch();
};

// Calls an action like a query: runs it when `args` change (by value) and on
// invalidation, exposing react-query style state. Pass "skip" to stay idle.
export function useActionQuery<Action extends FunctionReference<"action">>(
	action: Action,
	args: FunctionArgs<Action> | "skip",
	key?: string,
) {
	const run = useAction(action);
	const runRef = useRef(run);
	runRef.current = run;
	const argsKey = args === "skip" ? null : JSON.stringify(args);
	const [state, setState] = useState<{
		argsKey: string | null;
		data: FunctionReturnType<Action> | undefined;
		error: Error | null;
	}>({ argsKey: null, data: undefined, error: null });
	const [version, setVersion] = useState(0);
	const refetch = useCallback(() => setVersion((value) => value + 1), []);

	useEffect(() => {
		if (!key) return;
		const set = listeners.get(key) ?? new Set();
		set.add(refetch);
		listeners.set(key, set);
		return () => {
			set.delete(refetch);
			if (set.size === 0) listeners.delete(key);
		};
	}, [key, refetch]);

	useEffect(() => {
		if (argsKey === null) return;
		let cancelled = false;
		runRef
			.current(JSON.parse(argsKey))
			.then((data) => {
				if (!cancelled) setState({ argsKey, data, error: null });
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setState({
					argsKey,
					data: undefined,
					error: new Error(errorMessage(error)),
				});
			});
		return () => {
			cancelled = true;
		};
		// `version` re-runs the action on refetch/invalidation.
	}, [argsKey, version]);

	const current = state.argsKey === argsKey ? state : null;
	const data = current?.data;
	const error = current?.error ?? null;
	return {
		data,
		error,
		isError: error !== null,
		isPending: argsKey !== null && !current,
		refetch,
	};
}
