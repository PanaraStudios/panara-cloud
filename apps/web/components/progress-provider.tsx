"use client";

import { ProgressProvider as BProgressProvider } from "@bprogress/next/app";
import type { ReactNode } from "react";

// opensend's navigation feedback: thin ink bar along the top while the next
// route loads. Link clicks are picked up automatically; programmatic pushes
// should go through @bprogress/next's useRouter.
function ProgressProvider({ children }: { children: ReactNode }) {
	return (
		<BProgressProvider
			height="2px"
			color="var(--brand)"
			options={{ showSpinner: false }}
			shallowRouting
		>
			{children}
		</BProgressProvider>
	);
}

export { ProgressProvider };
