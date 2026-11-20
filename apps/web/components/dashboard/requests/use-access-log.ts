"use client";

import { useEffect, useState } from "react";
import { useLiveRpc } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";

// Access log entries or stats, read over the agent's access log
// session (the panel host's Traefik), polled while mounted.
export function useAccessLog<T>(
	op: "query" | "stats",
	payload: Record<string, unknown>,
	options: { enabled?: boolean; refetchInterval?: number } = {},
) {
	const { active } = useOrganization();
	const enabled = options.enabled ?? true;
	// Polling keeps the session busy for hours, so it eventually hits the
	// agent's session lifetime; reconnect instead of showing an error.
	const { call, error: sessionError } = useLiveRpc(
		enabled ? { kind: "accessLog", organizationId: active.id } : null,
		undefined,
		{ reconnect: true },
	);
	const [data, setData] = useState<T | undefined>();
	const [error, setError] = useState<string | null>(null);
	const key = JSON.stringify(payload);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		const load = () =>
			call<T>(op, JSON.parse(key) as Record<string, unknown>).then(
				(value) => {
					if (cancelled) return;
					setData(value);
					setError(null);
				},
				(err: unknown) =>
					!cancelled &&
					setError(err instanceof Error ? err.message : String(err)),
			);
		void load();
		if (!options.refetchInterval) return;
		const timer = setInterval(load, options.refetchInterval);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [call, op, key, enabled, options.refetchInterval]);

	const failure = error ?? sessionError;
	return {
		data,
		isLoading: enabled && data === undefined && !failure,
		isError: !!failure && data === undefined,
		error: failure ? new Error(failure) : null,
	};
}
