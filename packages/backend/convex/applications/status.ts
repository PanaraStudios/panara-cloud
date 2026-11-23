import { internalMutation, type QueryCtx } from "../_generated/server";
import { type ServiceStatus, statusBeforeJob } from "../lib/serviceStatus";
import { applicationGroup, hasActiveJob, previewGroup } from "./lib";

const BATCH = 100;

const latestJob = (
	ctx: QueryCtx,
	group: string,
	status: "failed" | "cancelled",
) =>
	ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", status),
		)
		.order("desc")
		.first();

// What a service left "running" by a job that ended without a report
// becomes: failed, unless the job that ended last was cancelled by its user,
// which puts the service back to what it was.
const settledStatus = async (
	ctx: QueryCtx,
	group: string,
	row: { status: ServiceStatus; statusBeforeDeploy?: ServiceStatus },
): Promise<ServiceStatus> => {
	const cancelled = await latestJob(ctx, group, "cancelled");
	if (!cancelled) return "error";
	const failed = await latestJob(ctx, group, "failed");
	return failed && failed._creationTime > cancelled._creationTime
		? "error"
		: statusBeforeJob(row);
};

// A deploy whose agent died is failed by the lease reaper without the agent
// reporting back, which would leave the service "running" forever.
export const settleStuck = internalMutation({
	args: {},
	handler: async (ctx) => {
		const apps = await ctx.db
			.query("applications")
			.withIndex("by_status", (q) => q.eq("status", "running"))
			.take(BATCH);
		for (const app of apps) {
			if (!(await hasActiveJob(ctx, applicationGroup(app._id)))) {
				await ctx.db.patch("applications", app._id, {
					status: await settledStatus(ctx, applicationGroup(app._id), app),
					statusBeforeDeploy: undefined,
				});
			}
		}
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_status", (q) => q.eq("status", "running"))
			.take(BATCH);
		for (const preview of previews) {
			if (!(await hasActiveJob(ctx, previewGroup(preview._id)))) {
				await ctx.db.patch("applicationPreviews", preview._id, {
					status: await settledStatus(ctx, previewGroup(preview._id), preview),
					statusBeforeDeploy: undefined,
				});
			}
		}
	},
});
