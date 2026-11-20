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
