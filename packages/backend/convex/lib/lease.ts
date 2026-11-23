import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAgent } from "./agentAuth";

// Every agent-facing function that acts on a job must hold its current lease.
// A mismatch means the job was reaped, cancelled, or reassigned.
export const requireLease = async (
	ctx: QueryCtx,
	jobId: Id<"jobs">,
	leaseId: string,
): Promise<{
	agent: Doc<"agents">;
	job: Doc<"jobs">;
	lease: Doc<"jobLeases">;
}> => {
	const agent = await requireAgent(ctx);
	const lease = await ctx.db
		.query("jobLeases")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.unique();
	if (!lease || lease.leaseId !== leaseId || lease.agentId !== agent._id) {
		throw new ConvexError("Lease lost");
	}
	const job = await ctx.db.get("jobs", jobId);
	if (job?.status !== "running") {
		throw new ConvexError("Lease lost");
	}
	return { agent, job, lease };
};

// What a job's log ends with when a cancel was asked for but the agent had
// already finished the work.
export const LATE_CANCEL_NOTE =
	"Cancel arrived after the work had finished: nothing was stopped, and the result stands.";

// A cancel that came too late: asked for while the job ran, and the job
// finished its work all the same (see `complete` in agent.ts).
export const cancelArrivedLate = (
	job: Pick<Doc<"jobs">, "status" | "cancelRequested">,
) => job.status === "succeeded" && job.cancelRequested;

// Ends the log of a job whose cancel came too late with a line that says so.
export const noteLateCancel = async (ctx: MutationCtx, jobId: Id<"jobs">) => {
	const last = await ctx.db
		.query("jobLogChunks")
		.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
		.order("desc")
		.first();
	await ctx.db.insert("jobLogChunks", {
		jobId,
		seq: (last?.seq ?? -1) + 1,
		text: `${last && !last.text.endsWith("\n") ? "\n" : ""}${LATE_CANCEL_NOTE}\n`,
	});
};

export const finishJob = async (
	ctx: MutationCtx,
	job: Doc<"jobs">,
	lease: Doc<"jobLeases">,
	outcome: { status: "succeeded" | "failed" | "cancelled"; error?: string },
) => {
	await ctx.db.patch("jobs", job._id, {
		status: outcome.status,
		error: outcome.error,
		finishedAt: Date.now(),
	});
	await ctx.db.delete("jobLeases", lease._id);
};
