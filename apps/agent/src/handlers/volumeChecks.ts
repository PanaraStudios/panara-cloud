import { api } from "@panara-cloud/backend/api";
import type { VolumeChecks, VolumeOutcome } from "../infra/volumeRemoval";
import type { JobContext, JobResult } from "./types";

// For a removal job that also deletes volumes: asks the panel, while the job
// runs, which other services on the server still name each volume.
export const volumeChecks = (
	ctx: JobContext,
	deletingTogether: string[] | undefined,
): VolumeChecks => ({
	deletingTogether,
	panelReferences: (volumeNames) =>
		ctx.convex.query(api.infra.agent.volumeReferences, {
			jobId: ctx.claim.jobId,
			leaseId: ctx.claim.leaseId,
			volumeNames,
		}),
});

export const volumeResult = (outcome: VolumeOutcome): JobResult =>
	outcome.removed.length > 0 || outcome.kept.length > 0
		? { kind: "volumes.removal", ...outcome }
		: { kind: "none" };
