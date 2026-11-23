"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerStatus } from "@/components/dashboard/docker/logs/viewer-shell";
import { errorMessage } from "@/lib/auth/errors";
import { useLiveRpc } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import {
	type AccessPage,
	RequestBuffer,
	type StatusClass,
} from "@/lib/requests";

/** The agent's largest page. */
const PAGE = 500;
const POLL_MS = 3000;

export interface RequestScope {
	host?: string;
	path?: string;
	client?: string;
	status?: StatusClass;
	/** How far back the list goes, in milliseconds. */
	rangeMs: number;
}

/**
 * The access log as a tail: the newest requests in the range that match the
 * filters, then whatever arrives, read over the agent's access-log session.
 * The agent only answers questions, so new requests are asked for every few
 * seconds from the last one held; older ones are read a page at a time.
 */
export function useRequestFeed(scope: RequestScope) {
	const { active } = useOrganization();
	// Polling keeps the session busy for hours, so it eventually hits the
	// agent's session lifetime; reconnect instead of showing an error.
	const { call, error: sessionError } = useLiveRpc(
		{ kind: "accessLog", organizationId: active.id },
		undefined,
		{ reconnect: true },
	);
	const [buffer] = useState(() => new RequestBuffer());
	const [version, setVersion] = useState(0);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [total, setTotal] = useState<number | undefined>();
	const [remaining, setRemaining] = useState<number | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const start = useRef("");
	const key = JSON.stringify(scope);

	useEffect(() => {
		const { rangeMs, ...filters } = JSON.parse(key) as RequestScope;
		const query = {
			host: filters.host,
			path: filters.path,
			client: filters.client,
			status: filters.status ? [filters.status] : undefined,
		};
		buffer.clear();
		start.current = new Date(Date.now() - rangeMs).toISOString();
		setVersion((value) => value + 1);
		setLoaded(false);
		setTotal(undefined);
		setRemaining(null);
		let cancelled = false;
		let busy = false;
		const load = async () => {
			if (busy) return;
			busy = true;
			try {
				const last = buffer.last;
				const page = await call<AccessPage>(
					"query",
					last
						? {
								...query,
								dateRange: { start: last.StartUTC },
								sort: { id: "StartUTC", desc: false },
								page: { pageIndex: 0, pageSize: PAGE },
							}
						: {
								...query,
								dateRange: { start: start.current },
								page: { pageIndex: 0, pageSize: PAGE },
							},
				);
				if (cancelled) return;
				const added = buffer.append(page.data);
				if (last) setTotal((value) => (value ?? 0) + added);
				else {
					setTotal(page.totalCount);
					setRemaining(Math.max(0, page.totalCount - page.data.length));
				}
				if (added > 0 || !last) setVersion((value) => value + 1);
				setLoaded(true);
				setError(null);
			} catch (failure) {
				if (!cancelled) setError(errorMessage(failure));
			} finally {
				busy = false;
			}
		};
		void load();
		const timer = setInterval(load, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [buffer, call, key]);

	const loadOlder = useCallback(async () => {
		const first = buffer.first;
		if (!first) return;
		const { rangeMs: _, ...filters } = JSON.parse(key) as RequestScope;
		setLoadingOlder(true);
		try {
			const page = await call<AccessPage>("query", {
				host: filters.host,
				path: filters.path,
				client: filters.client,
				status: filters.status ? [filters.status] : undefined,
				dateRange: { start: start.current, end: first.StartUTC },
				page: { pageIndex: 0, pageSize: PAGE },
			});
			// The page ends on the request it was asked from: that one is held.
			if (buffer.first !== first) return;
			const added = buffer.prepend(page.data);
			setRemaining(Math.max(0, page.totalCount - page.data.length));
			if (added > 0) setVersion((value) => value + 1);
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setLoadingOlder(false);
		}
	}, [buffer, call, key]);

	const failure = error ?? sessionError;
	const status: ViewerStatus = failure
		? "offline"
		: loaded
			? "live"
			: "connecting";
	return {
		buffer,
		version,
		loaded,
		status,
		error: failure,
		total,
		older: { remaining, loading: loadingOlder, load: loadOlder },
	};
}
