"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

/** Repository and branch listings are actions (they call the provider's
    API), so they are loaded on demand rather than subscribed to. `key`
    identifies the request; null disables it. */
export function useRemoteList<T>(key: string | null, load: () => Promise<T>) {
	const loadRef = useRef(load);
	loadRef.current = load;
	const [state, setState] = useState<{
		key: string | null;
		data?: T;
		error?: string;
	}>({ key: null });

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setState({ key });
		loadRef.current().then(
			(data) => {
				if (!cancelled) setState({ key, data });
			},
			(error: unknown) => {
				if (!cancelled) setState({ key, error: errorMessage(error) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [key]);

	const current = key && state.key === key ? state : undefined;
	return {
		data: current?.data,
		error: current?.error ?? null,
		isLoading:
			!!key && current?.data === undefined && current?.error === undefined,
	};
}
