import type { api } from "@panara-cloud/backend/api";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import type { LogSink } from "../logSink";

export type Claim = NonNullable<FunctionReturnType<typeof api.agent.claimNext>>;
export type JobTarget = FunctionReturnType<typeof api.agent.getJobTarget>;
export type JobResult =
	| { kind: "server.validate"; ok: boolean; details: string }
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
	) {
		super(message);
	}
}
