import type { api } from "@panara-cloud/backend/api";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import type { LogSink } from "../logSink";

export type Claim = NonNullable<FunctionReturnType<typeof api.agent.claimNext>>;
export type JobTarget = FunctionReturnType<typeof api.agent.getJobTarget>;
export type JobResult =
	| { kind: "server.validate"; ok: boolean; details: string }
	| {
			kind: "volumes.removal";
			removed: string[];
			kept: { name: string; reason: string }[];
	  }
	| { kind: "none" };

export type JobContext = {
	claim: Claim;
	log: LogSink;
	signal: AbortSignal;
	getTarget: () => Promise<JobTarget>;
	// For lease-guarded domain functions, e.g. fetching a deploy snapshot or
	// reporting progress. Always pass claim.jobId and claim.leaseId.
	convex: ConvexClient;
};

export class JobFailure extends Error {
	constructor(
		message: string,
		readonly result?: JobResult,
		// The work failed by itself after a cancel could no longer stop it (see
		// lib/handoff.ts): recorded as failed, not cancelled.
		readonly despiteCancel = false,
	) {
		super(message);
	}
}

// What `agent.fail` is told about a handler that threw. Once the job's
// signal is aborted every error reads "Cancelled", except a failure the
// cancel came too late to cause.
export const failureReport = (error: unknown, aborted: boolean) => {
	const despiteCancel = error instanceof JobFailure && error.despiteCancel;
	return {
		error:
			aborted && !despiteCancel
				? "Cancelled"
				: error instanceof Error
					? error.message
					: String(error),
		...(despiteCancel && { despiteCancel: true }),
	};
};
