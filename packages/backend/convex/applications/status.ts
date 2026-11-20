import { internalMutation } from "../_generated/server";
import { applicationGroup, hasActiveJob, previewGroup } from "./lib";

const BATCH = 100;

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
				await ctx.db.patch("applications", app._id, { status: "error" });
			}
		}
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_status", (q) => q.eq("status", "running"))
			.take(BATCH);
		for (const preview of previews) {
			if (!(await hasActiveJob(ctx, previewGroup(preview._id)))) {
				await ctx.db.patch("applicationPreviews", preview._id, {
					status: "error",
				});
			}
		}
	},
});
