"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

export type ErrorBoundaryProps = {
	error: Error & { digest?: string };
	reset: () => void;
};

// opensend's error-boundary retry: refresh server data, then re-render.
export function useServerError({ error, reset }: ErrorBoundaryProps) {
	const router = useRouter();

	useEffect(() => {
		console.error(error);
	}, [error]);

	return function retry() {
		startTransition(() => {
			router.refresh();
			reset();
		});
	};
}
