import type { Host } from "../../host";
import { withHost } from "../../host";
import { type JobContext, JobFailure } from "../types";

export const leaseArgs = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const withJobHost = async <T>(
	ctx: JobContext,
	fn: (host: Host) => Promise<T>,
): Promise<T> => withHost(await ctx.getTarget(), ctx.signal, fn);

// Logs the failure and rethrows it as a JobFailure.
export const fail = (ctx: JobContext, error: unknown): never => {
	const message = ctx.signal.aborted ? "Cancelled" : errorMessage(error);
	ctx.log.line(`❌ ${message}`);
	throw new JobFailure(message);
};
