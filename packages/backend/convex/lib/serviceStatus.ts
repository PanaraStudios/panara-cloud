import type { Doc } from "../_generated/dataModel";

export type ServiceStatus = "idle" | "running" | "done" | "error";

type StatusFields = {
	status: ServiceStatus;
	statusBeforeDeploy?: ServiceStatus;
};

// What a service goes back to when the job it is busy with ends without
// having changed it: what it was before the deploy that set "running", or
// what it still is when no deploy had begun (start, stop, restart).
export const statusBeforeJob = (row: StatusFields): ServiceStatus =>
	row.status === "running" ? (row.statusBeforeDeploy ?? "idle") : row.status;

// Whether an error a job reports is its user's cancel. The agent says
// `despiteCancel` when work Docker already had (a Swarm service it was told
// to update, containers `docker compose up` was replacing) failed by itself
// after a cancel could no longer stop it.
export const errorIsCancel = (
	job: Pick<Doc<"jobs">, "cancelRequested">,
	despiteCancel?: boolean,
) => job.cancelRequested && !despiteCancel;

// The status fields to write for what a job reports about its service.
// A job its user cancelled did not fail: the agent stops the work under the
// handler, which then reports an error like any other. Taken as a failure,
// a cancelled first deploy would read "Failed" and send a failure alert.
export const reportedStatus = (
	job: Pick<Doc<"jobs">, "cancelRequested">,
	row: StatusFields,
	reported: ServiceStatus,
	despiteCancel?: boolean,
): StatusFields => {
	if (reported === "running") {
		return {
			status: "running",
			statusBeforeDeploy: statusBeforeJob(row),
		};
	}
	return {
		status:
			reported === "error" && errorIsCancel(job, despiteCancel)
				? statusBeforeJob(row)
				: reported,
		statusBeforeDeploy: undefined,
	};
};
