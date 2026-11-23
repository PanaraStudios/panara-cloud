"use client";

import {
	ProgressProvider as BProgressProvider,
	useProgress,
} from "@bprogress/react";
import { type ReactNode, useEffect } from "react";
import { setProgressHooks } from "@/lib/router/store";

// Shows the bar while the router loads the code of a page not opened yet.
function RouterProgress() {
	const { start, stop } = useProgress();
	useEffect(() => {
		setProgressHooks({ start: () => start(), stop: () => stop() });
		return () => setProgressHooks(null);
	}, [start, stop]);
	return null;
}

// opensend's navigation feedback: thin ink bar along the top while the next
// route loads.
function ProgressProvider({ children }: { children: ReactNode }) {
	return (
		<BProgressProvider
			height="2px"
			color="var(--brand)"
			options={{ showSpinner: false }}
		>
			<RouterProgress />
			{children}
		</BProgressProvider>
	);
}

export { ProgressProvider };
