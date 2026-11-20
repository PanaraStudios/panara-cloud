import { checkGpuStatus, setupGpu } from "../../infra/gpu";
import type { JobContext, JobResult } from "../types";
import { refreshSnapshot, specOf, withJobHost } from "./common";

export const gpuSetup = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.gpuSetup");
	ctx.log.line("Setting up GPU support");
	await withJobHost(ctx, async (host) => {
		try {
			await setupGpu(host, ctx.log);
		} finally {
			await refreshSnapshot(ctx, "gpu", () => checkGpuStatus(host));
		}
	});
	return { kind: "none" };
};
