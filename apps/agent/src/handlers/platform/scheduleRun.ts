import { api } from "@panara-cloud/backend/api";
import { withHost } from "../../host";
import { runSchedule } from "../../platform/schedules";
import { type JobContext, JobFailure, type JobResult } from "../types";

export const scheduleRun = async (ctx: JobContext): Promise<JobResult> => {
	const run = await ctx.convex.query(api.platform.agent.getScheduleRunContext, {
		jobId: ctx.claim.jobId,
		leaseId: ctx.claim.leaseId,
	});
	const target = await ctx.getTarget();
	ctx.log.line(`Running schedule "${run.name}"`);
	let code: number | null;
	try {
		code = await withHost(target, ctx.signal, (host) =>
			runSchedule(host, run, {
				onOutput: (text) => ctx.log.append(text),
				signal: ctx.signal,
			}),
		);
	} catch (error) {
		ctx.log.line(
			`❌ ${error instanceof Error ? error.message : String(error)}`,
		);
		throw new JobFailure(
			error instanceof Error ? error.message : "Schedule run failed",
		);
	}
	if (ctx.signal.aborted) throw new JobFailure("Cancelled");
	if (code !== 0) {
		ctx.log.line("❌ Command failed");
		throw new JobFailure(`Command failed with exit code ${code}`);
	}
	ctx.log.line("✅ Command executed successfully");
	return { kind: "none" };
};
